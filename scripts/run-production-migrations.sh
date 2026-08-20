#!/usr/bin/env bash
# Production DDL must never run through the web/worker runtime database identity.
# Prefer a dedicated migration URL. A root-operated single-host installation may
# explicitly opt into PostgreSQL's passwordless local peer identity instead.
set -Eeuo pipefail

node_bin="$(command -v node)"
if [[ -z "$node_bin" ]]; then
  echo "node is required for production migrations" >&2
  exit 1
fi

if [[ -n "${AURORA_MIGRATION_DATABASE_URL:-}" ]]; then
  if [[ "${AURORA_MIGRATION_DATABASE_URL}" == "${DATABASE_URL:-}" ]]; then
    echo "migration and runtime database identities must be different" >&2
    exit 1
  fi
  echo "[deploy] migration identity: dedicated database role"
  DATABASE_URL="${AURORA_MIGRATION_DATABASE_URL}" "$node_bin" scripts/migrate.mjs
  exit 0
fi

if [[ "${AURORA_ALLOW_LOCAL_PEER_MIGRATIONS:-false}" != "true" ]]; then
  echo "no privileged production migration identity configured" >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "local peer migrations require the root-operated deploy account" >&2
  exit 1
fi
if ! command -v runuser >/dev/null 2>&1 || ! id postgres >/dev/null 2>&1; then
  echo "local PostgreSQL peer identity is unavailable" >&2
  exit 1
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required to validate the local migration target" >&2
  exit 1
fi

peer_database_url="$("$node_bin" scripts/production-local-migration-url.mjs)"
if [[ -z "$peer_database_url" ]]; then
  echo "local PostgreSQL peer target is empty" >&2
  exit 1
fi

echo "[deploy] migration identity: local PostgreSQL peer role"
runuser -u postgres -- env -i \
  DATABASE_URL="$peer_database_url" \
  HOME="/var/lib/postgresql" \
  "$node_bin" scripts/migrate.mjs
