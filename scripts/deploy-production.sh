#!/usr/bin/env bash
# Atomic production release for the Aurora VPS.
# Expected layout:
#   /opt/aurora-releases/<utc-timestamp>-<sha>
#   /opt/aurora-current -> current release
#   systemd units: aurora-web.service, aurora-worker.service
set -euo pipefail

REPO_URL="${AURORA_DEPLOY_REPO_URL:-https://github.com/isakovegor820-star/Kontent.git}"
DEPLOY_SHA="${AURORA_DEPLOY_SHA:?AURORA_DEPLOY_SHA is required}"
RELEASES_DIR="${AURORA_RELEASES_DIR:-/opt/aurora-releases}"
CURRENT_LINK="${AURORA_CURRENT_LINK:-/opt/aurora-current}"
KEEP_RELEASES="${AURORA_KEEP_RELEASES:-5}"
HEALTH_URL="${AURORA_HEALTH_URL:-http://127.0.0.1:3002/api/health}"
HEALTH_ATTEMPTS="${AURORA_HEALTH_ATTEMPTS:-30}"
HEALTH_SLEEP_SECS="${AURORA_HEALTH_SLEEP_SECS:-2}"

if [[ ! "$DEPLOY_SHA" =~ ^[0-9a-f]{7,40}$ ]]; then
  echo "AURORA_DEPLOY_SHA must be a git SHA" >&2
  exit 1
fi

mkdir -p "$RELEASES_DIR"
exec 9>"${RELEASES_DIR}/.deploy.lock"
if ! flock -n 9; then
  echo "another production deploy is already running" >&2
  exit 1
fi

short_sha="$(printf '%s' "$DEPLOY_SHA" | cut -c1-7)"
release="${RELEASES_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-${short_sha}"
if [[ -e "$release" ]]; then
  echo "release directory already exists: $release" >&2
  exit 1
fi

if [[ ! -f "${CURRENT_LINK}/.env.production" ]]; then
  echo "missing ${CURRENT_LINK}/.env.production" >&2
  exit 1
fi

echo "CLONE $release"
git clone --branch main --single-branch "$REPO_URL" "$release"
if ! git -C "$release" cat-file -e "${DEPLOY_SHA}^{commit}"; then
  git -C "$release" fetch --depth 1 origin "$DEPLOY_SHA"
fi
git -C "$release" checkout --detach "$DEPLOY_SHA"
git -C "$release" rev-parse --verify HEAD

cp --preserve=mode,ownership "${CURRENT_LINK}/.env.production" "${release}/.env.production"

cd "$release"
echo "INSTALL"
npm ci --no-audit --no-fund

echo "BUILD"
set -a
# shellcheck disable=SC1091
. ./.env.production
set +a
npm run build

echo "MIGRATE"
npm run db:migrate

previous="$(readlink -f "$CURRENT_LINK")"
echo "PREVIOUS=$previous"
echo "TARGET=$release"

swap_current() {
  local target="$1"
  ln -sfn "$target" "${CURRENT_LINK}.next"
  mv -Tf "${CURRENT_LINK}.next" "$CURRENT_LINK"
}

rollback() {
  echo "ROLLBACK $previous" >&2
  swap_current "$previous"
  systemctl restart aurora-web.service aurora-worker.service || true
}

swap_current "$release"

if ! systemctl restart aurora-web.service aurora-worker.service; then
  rollback
  echo "systemd restart failed" >&2
  exit 1
fi

ok=0
for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null; then
    ok=1
    break
  fi
  sleep "$HEALTH_SLEEP_SECS"
done

if [[ "$ok" -ne 1 ]]; then
  rollback
  echo "health check failed: $HEALTH_URL" >&2
  exit 1
fi

if ! systemctl is-active --quiet aurora-web.service \
  || ! systemctl is-active --quiet aurora-worker.service; then
  rollback
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
