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
BUILD_ARCHIVE="${AURORA_BUILD_ARCHIVE:-}"
BUILD_ARCHIVE_SHA256="${AURORA_BUILD_ARCHIVE_SHA256:-}"
AVATAR_BODY_LIMIT_BYTES="${AURORA_AVATAR_BODY_LIMIT_BYTES:-}"
DB_POOL_MAX_WEB="${AURORA_DB_POOL_MAX_WEB:-}"
DB_POOL_MAX_WORKER="${AURORA_DB_POOL_MAX_WORKER:-}"
AI_SERVICE_ENGINE="${AURORA_AI_SERVICE_ENGINE:-}"
AI_FALLBACK_ENGINES="${AURORA_AI_FALLBACK_ENGINES:-}"
AI_SEMANTIC_ENGINE="${AURORA_AI_SEMANTIC_ENGINE:-}"
AI_SEMANTIC_FALLBACK_ENGINES="${AURORA_AI_SEMANTIC_FALLBACK_ENGINES:-}"
HEALTH_URL="${AURORA_HEALTH_URL:-http://127.0.0.1:3002/api/health}"
HEALTH_ATTEMPTS="${AURORA_HEALTH_ATTEMPTS:-30}"
HEALTH_SLEEP_SECS="${AURORA_HEALTH_SLEEP_SECS:-2}"

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
if [[ "$DEPLOY_ACTION" == "deploy" ]]; then
  expected_build_archive="/tmp/aurora-build-${DEPLOY_SHA}.tar.gz"
  if [[ "$BUILD_ARCHIVE" != "$expected_build_archive" ]]; then
    echo "AURORA_BUILD_ARCHIVE must equal $expected_build_archive" >&2
    exit 1
  fi
  if [[ ! "$BUILD_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "AURORA_BUILD_ARCHIVE_SHA256 must be an exact lowercase SHA-256" >&2
    exit 1
  fi
  if [[ ! "$AVATAR_BODY_LIMIT_BYTES" =~ ^[0-9]+$ ]] \
    || (( AVATAR_BODY_LIMIT_BYTES < 10485760 || AVATAR_BODY_LIMIT_BYTES > 11010048 )); then
    echo "AURORA_AVATAR_BODY_LIMIT_BYTES must be between 10485760 and 11010048" >&2
    exit 1
  fi
  for pool_max in "$DB_POOL_MAX_WEB" "$DB_POOL_MAX_WORKER"; do
    if [[ ! "$pool_max" =~ ^[0-9]+$ ]] || (( pool_max < 1 || pool_max > 100 )); then
      echo "AURORA_DB_POOL_MAX_WEB and AURORA_DB_POOL_MAX_WORKER must be integers between 1 and 100" >&2
      exit 1
    fi
  done
  # These values are written verbatim into .env.production, which this script later sources
  # with `set -a`, so they are restricted to the engine-id charset rather than trusted.
  for engine_id in "$AI_SERVICE_ENGINE" "$AI_SEMANTIC_ENGINE"; do
    if [[ -n "$engine_id" && ! "$engine_id" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
      echo "AURORA_AI_SERVICE_ENGINE and AURORA_AI_SEMANTIC_ENGINE must be single engine ids" >&2
      exit 1
    fi
  done
  for engine_list in "$AI_FALLBACK_ENGINES" "$AI_SEMANTIC_FALLBACK_ENGINES"; do
    if [[ -n "$engine_list" && ! "$engine_list" =~ ^[a-z0-9][a-z0-9,-]*$ ]]; then
      echo "AURORA_AI_FALLBACK_ENGINES and AURORA_AI_SEMANTIC_FALLBACK_ENGINES must be comma-separated engine ids" >&2
      exit 1
    fi
  done
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

cleanup_failed_release() {
  local status="$?" current=""
  trap - EXIT
  [[ -z "$BUILD_ARCHIVE" ]] || rm -f -- "$BUILD_ARCHIVE"
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

# Runtime capacity and ingress contracts are release-specific. Keep the previous
# release's env untouched so rollback boots against its original configuration.
runtime_env="${release}/.env.production"
runtime_env_next="$(mktemp "${release}/.env.production.next.XXXXXX")"
# The web unit launches `next start` directly, so no npm script injects a runtime role
# and the process would resolve the role-less "shared" pool budget — which is not
# configured — and fail every database query. Declare the role in the shared runtime env;
# worker.mjs overrides it for itself because that unit reads the same file.
#
# The AI engine keys are release-managed for the same reason: an engine whose upstream route
# stops answering has to be routable away from without a hand-edit on the box, and a stale
# value pinned to a dead route takes Autopilot and /api/readiness down with it. An empty
# variable leaves the deployed value untouched.
awk -v avatar="$AVATAR_BODY_LIMIT_BYTES" -v web_pool="$DB_POOL_MAX_WEB" -v worker_pool="$DB_POOL_MAX_WORKER" \
    -v ai_service="$AI_SERVICE_ENGINE" -v ai_fallbacks="$AI_FALLBACK_ENGINES" \
    -v ai_semantic="$AI_SEMANTIC_ENGINE" -v ai_semantic_fallbacks="$AI_SEMANTIC_FALLBACK_ENGINES" '
  BEGIN {
    avatar_written = 0; web_pool_written = 0; worker_pool_written = 0; role_written = 0
    ai_service_written = 0; ai_fallbacks_written = 0
    ai_semantic_written = 0; ai_semantic_fallbacks_written = 0
  }
  /^AI_SERVICE_ENGINE=/ {
    if (ai_service == "") { print; next }
    if (!ai_service_written) print "AI_SERVICE_ENGINE=" ai_service
    ai_service_written = 1
    next
  }
  /^AI_FALLBACK_ENGINES=/ {
    if (ai_fallbacks == "") { print; next }
    if (!ai_fallbacks_written) print "AI_FALLBACK_ENGINES=" ai_fallbacks
    ai_fallbacks_written = 1
    next
  }
  /^AI_SEMANTIC_ENGINE=/ {
    if (ai_semantic == "") { print; next }
    if (!ai_semantic_written) print "AI_SEMANTIC_ENGINE=" ai_semantic
    ai_semantic_written = 1
    next
  }
  /^AI_SEMANTIC_FALLBACK_ENGINES=/ {
    if (ai_semantic_fallbacks == "") { print; next }
    if (!ai_semantic_fallbacks_written) print "AI_SEMANTIC_FALLBACK_ENGINES=" ai_semantic_fallbacks
    ai_semantic_fallbacks_written = 1
    next
  }
  /^AURORA_AVATAR_BODY_LIMIT_BYTES=/ {
    if (!avatar_written) print "AURORA_AVATAR_BODY_LIMIT_BYTES=" avatar
    avatar_written = 1
    next
  }
  /^AURORA_DB_POOL_MAX_WEB=/ {
    if (!web_pool_written) print "AURORA_DB_POOL_MAX_WEB=" web_pool
    web_pool_written = 1
    next
  }
  /^AURORA_DB_POOL_MAX_WORKER=/ {
    if (!worker_pool_written) print "AURORA_DB_POOL_MAX_WORKER=" worker_pool
    worker_pool_written = 1
    next
  }
  /^AURORA_RUNTIME_ROLE=/ {
    if (!role_written) print "AURORA_RUNTIME_ROLE=web"
    role_written = 1
    next
  }
  { print }
  END {
    if (!avatar_written) print "AURORA_AVATAR_BODY_LIMIT_BYTES=" avatar
    if (!web_pool_written) print "AURORA_DB_POOL_MAX_WEB=" web_pool
    if (!worker_pool_written) print "AURORA_DB_POOL_MAX_WORKER=" worker_pool
    if (!role_written) print "AURORA_RUNTIME_ROLE=web"
    if (ai_service != "" && !ai_service_written) print "AI_SERVICE_ENGINE=" ai_service
    if (ai_fallbacks != "" && !ai_fallbacks_written) print "AI_FALLBACK_ENGINES=" ai_fallbacks
    if (ai_semantic != "" && !ai_semantic_written) print "AI_SEMANTIC_ENGINE=" ai_semantic
    if (ai_semantic_fallbacks != "" && !ai_semantic_fallbacks_written) {
      print "AI_SEMANTIC_FALLBACK_ENGINES=" ai_semantic_fallbacks
    }
  }
' "$runtime_env" > "$runtime_env_next"
chmod --reference="$runtime_env" "$runtime_env_next"
chown --reference="$runtime_env" "$runtime_env_next"
mv -f -- "$runtime_env_next" "$runtime_env"

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
echo "INSTALL_RUNTIME"
npm ci --omit=dev --no-audit --no-fund

echo "INSTALL_BUILD_ARTIFACT"
if [[ ! -f "$BUILD_ARCHIVE" ]]; then
  echo "missing production build artifact: $BUILD_ARCHIVE" >&2
  exit 1
fi
printf '%s  %s\n' "$BUILD_ARCHIVE_SHA256" "$BUILD_ARCHIVE" | sha256sum --check --status
archive_manifest="${release}/.build-artifact-manifest"
if ! tar -tzf "$BUILD_ARCHIVE" > "$archive_manifest" \
  || [[ ! -s "$archive_manifest" ]] \
  || grep -Eq '(^/|(^|/)\.\.(/|$))' "$archive_manifest" \
  || grep -Evq '^\.next(/|$)' "$archive_manifest"; then
  echo "production build artifact contains invalid paths" >&2
  exit 1
fi
tar --no-same-owner --no-same-permissions -xzf "$BUILD_ARCHIVE" -C "$release"
rm -f -- "$archive_manifest"
rm -f -- "$BUILD_ARCHIVE"
BUILD_ARCHIVE=""
if [[ ! -f "${release}/.next/BUILD_ID" ]]; then
  echo "production build artifact is missing .next/BUILD_ID" >&2
  exit 1
fi

migration_allow_local_peer="${AURORA_ALLOW_LOCAL_PEER_MIGRATIONS:-false}"
(
  echo "LOAD_RUNTIME_ENV"
  set -a
  # shellcheck disable=SC1091
  . ./.env.production
  set +a
  echo "MIGRATE"
  AURORA_ALLOW_LOCAL_PEER_MIGRATIONS="$migration_allow_local_peer" \
    bash scripts/run-production-migrations.sh
)

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

# The monthly-campaign profile digest no longer covers `content_brief.updated_at`, so plans
# written by earlier releases carry the previous digest and would read as outdated. This
# re-baseline only rewrites rows that still match that exact digest, runs on the runtime
# identity because it touches no schema, and stays recoverable from Autopilot -> Month, so a
# failure here must not roll a healthy release back.
echo "REBASE_MONTHLY_PROFILE_HASHES"
if ! (
  set -a
  # shellcheck disable=SC1091
  . ./.env.production
  set +a
  node scripts/rebase-monthly-profile-hashes.mjs
); then
  echo "monthly profile hash rebase failed; plans stay usable via Refresh in Autopilot" >&2
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
