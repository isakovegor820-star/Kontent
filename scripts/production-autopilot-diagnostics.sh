#!/usr/bin/env bash
# Runs on the production host over SSH. Read-only by construction: it inspects
# systemd, the deployed release, Redis key cardinalities and PostgreSQL catalogs,
# and it reproduces the worker's own startup gate. It starts nothing, restarts
# nothing and writes nothing.
#
# Redaction contract: only key NAMES leave `.env.production`, journal lines are
# filtered to Aurora's own log prefixes, and every line is scrubbed of embedded
# credentials before it is printed.
set -Eeuo pipefail

CURRENT_LINK="${AURORA_CURRENT_LINK:-/opt/aurora-current}"

# Journals and stack traces can echo a DSN. Strip credentials, bearer tokens and
# long opaque secrets before anything reaches the workflow log.
redact() {
  sed -E \
    -e 's#(://)[^:/@[:space:]]+:[^@[:space:]]+@#\1REDACTED:REDACTED@#g' \
    -e 's#(Bearer|bearer)[[:space:]]+[A-Za-z0-9._~+/=-]{8,}#\1 REDACTED#g' \
    -e 's#[0-9]{8,10}:[A-Za-z0-9_-]{30,}#TELEGRAM_TOKEN_REDACTED#g' \
    -e 's#\b(sk|pk|ghp|gho|xox[a-z])-[A-Za-z0-9_-]{10,}#\1-REDACTED#g'
}

section() { printf '\n===== %s =====\n' "$1"; }

section "HOST AND RELEASE"
current_path="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
printf 'current_link=%s\n' "$CURRENT_LINK"
printf 'current_path=%s\n' "${current_path:-MISSING}"
if [[ -n "$current_path" && -d "$current_path" ]]; then
  printf 'current_sha=%s\n' "$(git -C "$current_path" rev-parse --verify HEAD 2>/dev/null || echo unknown)"
  printf 'current_subject=%s\n' "$(git -C "$current_path" log -1 --format=%s 2>/dev/null || echo unknown)"
  printf 'build_id=%s\n' "$(cat "$current_path/.next/BUILD_ID" 2>/dev/null || echo missing)"
fi
printf 'releases=%s\n' "$(ls -1 /opt/aurora-releases 2>/dev/null | paste -sd, - || echo none)"
printf 'uptime=%s\n' "$(uptime -p 2>/dev/null || true)"
printf 'server_time=%s\n' "$(date -Is)"
printf 'timezone=%s\n' "$(timedatectl show -p Timezone --value 2>/dev/null || echo unknown)"

section "SYSTEMD SERVICE STATE"
for unit in aurora-web.service aurora-worker.service nginx.service; do
  printf '%s active=%s sub=%s restarts=%s since=%s result=%s\n' \
    "$unit" \
    "$(systemctl is-active "$unit" 2>/dev/null || true)" \
    "$(systemctl show "$unit" -p SubState --value 2>/dev/null || true)" \
    "$(systemctl show "$unit" -p NRestarts --value 2>/dev/null || true)" \
    "$(systemctl show "$unit" -p ActiveEnterTimestamp --value 2>/dev/null || true)" \
    "$(systemctl show "$unit" -p Result --value 2>/dev/null || true)"
done

section "WORKER UNIT DEFINITION (ExecStart only)"
systemctl show aurora-worker.service -p ExecStart --value 2>/dev/null | redact || true
printf 'worker_environment_keys=%s\n' \
  "$(systemctl show aurora-worker.service -p Environment --value 2>/dev/null \
      | tr ' ' '\n' | sed -E 's/=.*//' | grep -E '^[A-Z_]+$' | paste -sd, - || true)"
printf 'worker_environment_files=%s\n' \
  "$(systemctl show aurora-worker.service -p EnvironmentFiles --value 2>/dev/null || true)"

section "WEB UNIT DEFINITION (ExecStart only)"
systemctl show aurora-web.service -p ExecStart --value 2>/dev/null | redact || true
printf 'web_environment_keys=%s\n' \
  "$(systemctl show aurora-web.service -p Environment --value 2>/dev/null \
      | tr ' ' '\n' | sed -E 's/=.*//' | grep -E '^[A-Z_]+$' | paste -sd, - || true)"

section "WORKER JOURNAL (Aurora log prefixes only, last 25 min)"
journalctl -u aurora-worker.service --since '-25 min' --no-pager -o cat 2>/dev/null \
  | grep -aE '^\[(worker|start|autopilot)\]|schema preflight|preflight failed|database_pool|Error:|error:|ECONNREFUSED|ENOTFOUND|listen|ready' \
  | tail -n 60 | redact || echo "(no matching journal lines)"

section "WEB JOURNAL (Aurora log prefixes only, last 25 min)"
journalctl -u aurora-web.service --since '-25 min' --no-pager -o cat 2>/dev/null \
  | grep -aE '^\[(worker|start|web)\]|preflight|database_pool|Error:|error:' \
  | tail -n 40 | redact || echo "(no matching journal lines)"

section "RUNTIME ENV KEY NAMES (values never printed)"
if [[ -n "$current_path" && -f "$current_path/.env.production" ]]; then
  printf 'env_file=%s\n' "$current_path/.env.production"
  printf 'env_keys=%s\n' \
    "$(sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' "$current_path/.env.production" | sort -u | paste -sd, -)"
  for key in AI_API_KEY AI_DAILY_LIMIT REDIS_URL DATABASE_URL TG_BOT_TOKEN \
             AURORA_WORKER_MODE AURORA_RUNTIME_ROLE AURORA_DB_POOL_MAX \
             AURORA_DB_POOL_MAX_WEB AURORA_DB_POOL_MAX_WORKER; do
    value="$(sed -nE "s/^${key}=(.*)$/\1/p" "$current_path/.env.production" | tail -n 1)"
    if [[ -z "$value" ]]; then
      printf '%s=<absent-or-empty>\n' "$key"
    elif [[ "$key" == "AI_DAILY_LIMIT" || "$key" == AURORA_* ]]; then
      # Non-secret tuning knobs: the exact value is the diagnosis.
      printf '%s=%s\n' "$key" "$value"
    else
      printf '%s=<present:%s chars>\n' "$key" "${#value}"
    fi
  done
else
  echo "MISSING .env.production"
fi

section "WORKER STARTUP GATE REPRODUCTION (deployed release code, read-only)"
# This is the decisive probe: it calls the exact preflight worker.mjs calls before it
# opens Redis, registers the BullMQ consumer or schedules the Sunday plan cron.
if [[ -n "$current_path" && -f "$current_path/scripts/runtime-schema-preflight.mjs" ]]; then
  (
    cd "$current_path"
    set -a
    # shellcheck disable=SC1091
    . ./.env.production
    set +a
    AURORA_RUNTIME_ROLE=worker NODE_ENV=production node --input-type=module -e '
      const { assertRuntimeSchemaReady } = await import("./scripts/runtime-schema-preflight.mjs");
      const { SCHEMA_MANIFEST } = await import("./src/lib/schema-manifest.mjs");
      try {
        const report = await assertRuntimeSchemaReady();
        console.log(JSON.stringify({ preflight: "ok", expectedSchemaVersion: SCHEMA_MANIFEST.schemaVersion, ...report }, null, 2));
      } catch (error) {
        console.log(JSON.stringify({
          preflight: "FAILED",
          expectedSchemaVersion: SCHEMA_MANIFEST.schemaVersion,
          manifestMigrations: SCHEMA_MANIFEST.migrations.length,
          code: error?.code || String(error?.message || error),
          reasons: error?.reasons || [],
        }, null, 2));
      }
      process.exit(0);
    ' 2>&1 | redact
  ) || echo "(preflight probe could not run)"
else
  echo "(deployed release has no runtime-schema-preflight.mjs)"
fi

section "REDIS AUTOPILOT QUEUE STATE"
if [[ -n "$current_path" && -f "$current_path/.env.production" ]]; then
  (
    cd "$current_path"
    set -a
    # shellcheck disable=SC1091
    . ./.env.production
    set +a
    if [[ -z "${REDIS_URL:-}" ]]; then
      echo "REDIS_URL absent"
    elif ! command -v redis-cli >/dev/null 2>&1; then
      echo "redis-cli not installed on host"
    else
      printf 'ping=%s\n' "$(redis-cli -u "$REDIS_URL" ping 2>&1 | redact)"
      for queue in autopilot-plans publish; do
        printf '%s wait=%s active=%s delayed=%s failed=%s completed=%s paused=%s\n' \
          "$queue" \
          "$(redis-cli -u "$REDIS_URL" llen "bull:${queue}:wait" 2>/dev/null)" \
          "$(redis-cli -u "$REDIS_URL" llen "bull:${queue}:active" 2>/dev/null)" \
          "$(redis-cli -u "$REDIS_URL" zcard "bull:${queue}:delayed" 2>/dev/null)" \
          "$(redis-cli -u "$REDIS_URL" zcard "bull:${queue}:failed" 2>/dev/null)" \
          "$(redis-cli -u "$REDIS_URL" zcard "bull:${queue}:completed" 2>/dev/null)" \
          "$(redis-cli -u "$REDIS_URL" exists "bull:${queue}:paused" 2>/dev/null)"
        # A registered BullMQ consumer is exactly what /api/autopilot/generate counts.
        printf '%s consumers=%s\n' \
          "$queue" \
          "$(redis-cli -u "$REDIS_URL" --no-raw client list 2>/dev/null | grep -c "bull:${queue}" || echo 0)"
      done
      printf 'autopilot_meta_keys=%s\n' \
        "$(redis-cli -u "$REDIS_URL" --scan --pattern 'bull:autopilot-plans:*' --count 200 2>/dev/null | wc -l)"
    fi
  ) || echo "(redis probe failed)"
fi

section "AUTOPILOT DATABASE STATE (read-only transaction)"
if [[ -n "${AURORA_DIAG_SQL_B64:-}" && -n "$current_path" && -f "$current_path/.env.production" ]]; then
  (
    cd "$current_path"
    set -a
    # shellcheck disable=SC1091
    . ./.env.production
    set +a
    if [[ -z "${DATABASE_URL:-}" ]]; then
      echo "DATABASE_URL absent"
    else
      printf '%s' "$AURORA_DIAG_SQL_B64" \
        | base64 --decode \
        | psql "$DATABASE_URL" -X --no-psqlrc --set=ON_ERROR_STOP=1 2>&1 \
        | redact
    fi
  ) || echo "(database probe failed)"
else
  echo "(no diagnostics SQL supplied)"
fi

section "END OF REPORT"
