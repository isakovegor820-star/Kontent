#!/usr/bin/env bash
# Production release orchestration for the Aurora VPS. The application symlink is
# switched atomically; database migrations are forward-only and are not rolled back.
# Expected layout:
#   /opt/aurora-releases/<utc-timestamp>-<sha>
#   /opt/aurora-current -> current release
#   systemd units: aurora-web.service, aurora-worker.service
set -euo pipefail

REPO_URL="${AURORA_DEPLOY_REPO_URL:-https://github.com/isakovegor820-star/Kontent.git}"
DEPLOY_SHA="${AURORA_DEPLOY_SHA:?AURORA_DEPLOY_SHA is required}"
DEPLOY_ACTION="${AURORA_DEPLOY_ACTION:-deploy}"
RELEASES_DIR="${AURORA_RELEASES_DIR:-/opt/aurora-releases}"
CURRENT_LINK="${AURORA_CURRENT_LINK:-/opt/aurora-current}"
KEEP_RELEASES="${AURORA_KEEP_RELEASES:-2}"
CLEANUP_RELEASE_SHA="${AURORA_INCOMPLETE_RELEASE_SHA:-}"
HEALTH_URL="${AURORA_HEALTH_URL:-http://127.0.0.1:3002/api/health}"
HEALTH_ATTEMPTS="${AURORA_HEALTH_ATTEMPTS:-30}"
HEALTH_SLEEP_SECS="${AURORA_HEALTH_SLEEP_SECS:-2}"
WORKER_SERVICE="aurora-worker.service"
worker_paused_for_build=0

if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "AURORA_DEPLOY_SHA must be an exact 40-character git SHA" >&2
  exit 1
fi
if [[ -n "$CLEANUP_RELEASE_SHA" && ! "$CLEANUP_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "AURORA_INCOMPLETE_RELEASE_SHA must be empty or an exact 40-character git SHA" >&2
  exit 1
fi
if [[ "$DEPLOY_ACTION" != "deploy" && "$DEPLOY_ACTION" != "rollback" ]]; then
  echo "AURORA_DEPLOY_ACTION must be deploy or rollback" >&2
  exit 1
fi

mkdir -p "$RELEASES_DIR"
exec 9>"${RELEASES_DIR}/.deploy.lock"
if ! flock -n 9; then
  echo "another production deploy is already running" >&2
  exit 1
fi

swap_current() {
  local target="$1"
  ln -sfn "$target" "${CURRENT_LINK}.next"
  mv -Tf "${CURRENT_LINK}.next" "$CURRENT_LINK"
}

services_active() {
  systemctl is-active --quiet aurora-web.service \
    && systemctl is-active --quiet aurora-worker.service
}

wait_for_health() {
  local ok=0
  for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null && services_active; then
      ok=1
      break
    fi
    sleep "$HEALTH_SLEEP_SECS"
  done
  [[ "$ok" -eq 1 ]]
}

rollback_to() {
  local target="$1"
  echo "ROLLBACK $target" >&2
  swap_current "$target"
  systemctl restart aurora-web.service aurora-worker.service
  wait_for_health
  services_active
}

state_file="${RELEASES_DIR}/.deploy-state-${DEPLOY_SHA}"
if [[ "$DEPLOY_ACTION" == "rollback" ]]; then
  if [[ ! -f "$state_file" ]]; then
    echo "rollback state missing for $DEPLOY_SHA" >&2
    exit 1
  fi
  mapfile -t deploy_state < "$state_file"
  previous="${deploy_state[0]:-}"
  target="${deploy_state[1]:-}"
  boundary="${deploy_state[2]:-}"
  if [[ "$boundary" != "rollback-compatible" \
    || -z "$previous" || -z "$target" \
    || ! -d "$previous" || ! -d "$target" \
    || "$(readlink -f "$CURRENT_LINK")" != "$target" ]]; then
    echo "rollback state is invalid or no longer current" >&2
    exit 1
  fi
  rollback_to "$previous"
  printf '%s\n' "rolled-back" >> "$state_file"
  echo "ROLLBACK_OK sha=$DEPLOY_SHA release=$previous"
  exit 0
fi

short_sha="$(printf '%s' "$DEPLOY_SHA" | cut -c1-7)"

# A failed build can leave a full node_modules tree and a partial .next cache behind.
# Cleanup is opt-in and bound to an exact operator-provided SHA. A completed deploy
# records both rollback participants before switching the symlink, so those stay safe.
release_is_recorded() {
  local candidate="$1" state
  for state in "${RELEASES_DIR}"/.deploy-state-*; do
    [[ -f "$state" ]] || continue
    if [[ "$(sed -n '3p' "$state")" == "rollback-compatible" ]] \
      && sed -n '1,2p' "$state" | grep -Fxq "$candidate"; then
      return 0
    fi
  done
  return 1
}

cleanup_incomplete_releases() {
  local current candidate candidate_sha
  [[ -n "$CLEANUP_RELEASE_SHA" ]] || return 0
  current="$(readlink -f "$CURRENT_LINK")"
  while IFS= read -r candidate; do
    [[ -n "$candidate" && -d "$candidate" ]] || continue
    candidate="$(readlink -f "$candidate")"
    [[ "$candidate" == "${RELEASES_DIR}/"* ]] || continue
    [[ "$candidate" != "$current" ]] || continue
    if release_is_recorded "$candidate"; then
      continue
    fi
    candidate_sha="$(git -C "$candidate" rev-parse --verify HEAD 2>/dev/null || true)"
    [[ "$candidate_sha" == "$CLEANUP_RELEASE_SHA" ]] || continue
    echo "PRUNE_INCOMPLETE $candidate"
    rm -rf -- "$candidate"
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print)
}

cleanup_incomplete_releases

release="${RELEASES_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-${short_sha}"
if [[ -e "$release" ]]; then
  echo "release directory already exists: $release" >&2
  exit 1
fi

resume_worker_after_build() {
  [[ "$worker_paused_for_build" -eq 1 ]] || return 0
  echo "RESUME_WORKER_AFTER_BUILD"
  systemctl start "$WORKER_SERVICE"
  worker_paused_for_build=0
}

cleanup_failed_release() {
  local status="$?" current=""
  trap - EXIT
  if [[ "$worker_paused_for_build" -eq 1 ]]; then
    if ! resume_worker_after_build; then
      echo "failed to resume $WORKER_SERVICE after interrupted build" >&2
      status=1
    fi
  fi
  current="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
  if [[ "$status" -ne 0 && -n "$release" && -d "$release" && "$current" != "$release" ]]; then
    echo "PRUNE_FAILED $release" >&2
    rm -rf -- "$release"
    rm -f -- "$state_file"
  fi
  exit "$status"
}
trap cleanup_failed_release EXIT

if [[ ! -f "${CURRENT_LINK}/.env.production" ]]; then
  echo "missing ${CURRENT_LINK}/.env.production" >&2
  exit 1
fi

previous="$(readlink -f "$CURRENT_LINK")"
previous_sha="$(git -C "$previous" rev-parse --verify HEAD)"
if [[ ! "$previous_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "previous release HEAD is not an exact SHA" >&2
  exit 1
fi

echo "CLONE $release"
git clone --branch main --single-branch "$REPO_URL" "$release"
if ! git -C "$release" cat-file -e "${DEPLOY_SHA}^{commit}"; then
  git -C "$release" fetch --depth 1 origin "$DEPLOY_SHA"
fi
git -C "$release" checkout --detach "$DEPLOY_SHA"
checked_out_sha="$(git -C "$release" rev-parse --verify HEAD)"
if [[ "$checked_out_sha" != "$DEPLOY_SHA" ]]; then
  echo "checked-out release SHA does not match AURORA_DEPLOY_SHA" >&2
  exit 1
fi

cp --preserve=mode,ownership "${CURRENT_LINK}/.env.production" "${release}/.env.production"

if [[ -n "${AURORA_SCHEMA_ROLLBACK_AUDIT:-}" \
  && ! "${AURORA_SCHEMA_ROLLBACK_AUDIT}" =~ ^[0-9a-f]{40}:[0-9a-f]{40}$ ]]; then
  echo "AURORA_SCHEMA_ROLLBACK_AUDIT must be an exact previous:target SHA pair" >&2
  exit 1
fi
node "${release}/scripts/verify-rollback-boundary.mjs" \
  "${previous}/src/lib/schema-manifest.mjs" \
  "${release}/src/lib/schema-manifest.mjs" \
  "$previous_sha" "$DEPLOY_SHA"

cd "$release"
echo "INSTALL"
npm ci --no-audit --no-fund

echo "BUILD"
set -a
# shellcheck disable=SC1091
. ./.env.production
set +a
if systemctl is-active --quiet "$WORKER_SERVICE"; then
  # Keep the live web service available while temporarily reclaiming the worker's
  # memory for Next/Sentry compilation on the fixed-size production VPS.
  worker_paused_for_build=1
  echo "PAUSE_WORKER_FOR_BUILD"
  systemctl stop "$WORKER_SERVICE"
fi
npm run build
resume_worker_after_build

echo "MIGRATE"
bash scripts/run-production-migrations.sh

echo "PREVIOUS=$previous"
echo "TARGET=$release"

printf '%s\n%s\n%s\n' "$previous" "$release" "rollback-compatible" > "$state_file"

swap_current "$release"

if ! systemctl restart aurora-web.service aurora-worker.service; then
  rollback_to "$previous" || true
  echo "systemd restart failed" >&2
  exit 1
fi

if ! wait_for_health; then
  rollback_to "$previous" || true
  echo "health check failed: $HEALTH_URL" >&2
  exit 1
fi

if ! services_active; then
  rollback_to "$previous" || true
  echo "systemd services are not active after deploy" >&2
  exit 1
fi

current="$(readlink -f "$CURRENT_LINK")"
# Keep the live release, the previous release, and the newest KEEP_RELEASES dirs.
keep_list="$(printf '%s\n%s\n' "$current" "$previous")"
old_releases="$(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -print | sort -r)"
kept=0
while IFS= read -r dir; do
  [[ -n "$dir" ]] || continue
  if printf '%s\n' "$keep_list" | grep -Fxq "$dir"; then
    continue
  fi
  kept=$((kept + 1))
  if [[ "$kept" -gt "$KEEP_RELEASES" ]]; then
    echo "PRUNE $dir"
    rm -rf "$dir"
  fi
done <<< "$old_releases"

echo "DEPLOY_OK sha=$(git -C "$release" rev-parse HEAD) release=$release"
