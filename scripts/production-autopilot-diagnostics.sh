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

section "WORKER JOURNAL (Autopilot build decisions, last 3 h)"
# `[bot] конфликт` repeats every 10 s while a second Telegram poller holds the lease, which
# is enough to push every Autopilot line out of any plain tail. These are the lines that say
# whether a build even started and why it stopped, so they get their own window.
journalctl -u aurora-worker.service --since '-3 hours' --no-pager -o cat 2>/dev/null \
  | grep -aE '^\[(auto|autopilot|worker ai)\]|нет брифа|канал .* недоступен|устарела|no_brief|no_channel' \
  | tail -n 80 | redact || echo "(no Autopilot journal lines)"

section "AI TELEMETRY CODE HISTOGRAM (worker, last 6 h)"
# `[worker ai]` logs an object, so journalctl renders `code:`/`engine:` on their own lines
# and a plain grep for the prefix returns only `[worker ai] {`. The code is the whole
# diagnosis: `provider_error` means the upstream route answered, `overall_timeout` means the
# build ran out of its own budget, and `circuit_open` means a previous failure is still
# suppressing an engine that may itself be healthy.
worker_ai_log="$(journalctl -u aurora-worker.service --since '-6 hours' --no-pager -o cat 2>/dev/null || true)"
if [[ -z "$worker_ai_log" ]]; then
  echo "(no journal)"
else
  printf '%s\n' "$worker_ai_log" \
    | grep -aA 9 -E '^\[worker ai\]' \
    | grep -aE '^\s+(code|engine|surface|outcome|event|toEngine):' \
    | sed -E 's/^\s+//; s/,$//' \
    | sort | uniq -c | sort -rn | head -40 || echo "(no [worker ai] telemetry)"
fi

section "WORKER JOURNAL (unfiltered tail since the newest restart)"
# The prefix filter above answers "did the gate fail". It cannot answer "how far did
# startup get", and a worker that is `active (running)` while registering no BullMQ
# consumer has stopped somewhere in top-level initialization that logs nothing matching
# those prefixes. Every line is redacted, same contract as the rest of this report.
worker_since="$(systemctl show aurora-worker.service -p ActiveEnterTimestamp --value 2>/dev/null || true)"
if [[ -n "$worker_since" ]]; then
  journalctl -u aurora-worker.service --since "$worker_since" --no-pager -o cat 2>/dev/null \
    | tail -n 120 | redact || echo "(no journal lines since restart)"
else
  journalctl -u aurora-worker.service --no-pager -o cat -n 120 2>/dev/null | redact || true
fi

section "WEB JOURNAL (Aurora log prefixes only, last 25 min)"
journalctl -u aurora-web.service --since '-25 min' --no-pager -o cat 2>/dev/null \
  | grep -aE '^\[(worker|start|web)\]|preflight|database_pool|Error:|error:' \
  | tail -n 40 | redact || echo "(no matching journal lines)"

section "RUNTIME ENV KEY NAMES (values never printed)"
if [[ -n "$current_path" && -f "$current_path/.env.production" ]]; then
  printf 'env_file=%s\n' "$current_path/.env.production"
  printf 'env_keys=%s\n' \
    "$(sed -nE 's/^([A-Za-z_][A-Za-z0-9_]*)=.*/\1/p' "$current_path/.env.production" | sort -u | paste -sd, -)"
  # The AI_*_ENGINE values are model identifiers rather than credentials, and they decide
  # which upstream route every unpinned surface and the fact-check gate actually call, so a
  # single dead pinned engine is indistinguishable from "Autopilot is broken" without them.
  for key in AI_API_KEY AI_DAILY_LIMIT REDIS_URL DATABASE_URL TG_BOT_TOKEN \
             AURORA_WORKER_MODE AURORA_RUNTIME_ROLE AURORA_DB_POOL_MAX \
             AURORA_DB_POOL_MAX_WEB AURORA_DB_POOL_MAX_WORKER \
             AI_SERVICE_ENGINE AI_FALLBACK_ENGINES AI_FALLBACK_STRICT \
             AI_SEMANTIC_ENGINE AI_SEMANTIC_FALLBACK_ENGINES AI_SEMANTIC_TIMEOUT_MS \
             SITE_ANALYSIS_ENGINE; do
    value="$(sed -nE "s/^${key}=(.*)$/\1/p" "$current_path/.env.production" | tail -n 1)"
    if [[ -z "$value" ]]; then
      printf '%s=<absent-or-empty>\n' "$key"
    elif [[ "$key" == "AI_DAILY_LIMIT" || "$key" == AURORA_* || "$key" == AI_*ENGINE* \
            || "$key" == "AI_FALLBACK_STRICT" || "$key" == "AI_SEMANTIC_TIMEOUT_MS" \
            || "$key" == "SITE_ANALYSIS_ENGINE" ]]; then
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
        # A registered BullMQ consumer is exactly what /api/autopilot/generate counts, and
        # BullMQ names that client after the base64 of the queue name, not the queue name.
        # Matching the plain name reported zero consumers for a fully healthy worker.
        queue_b64="$(printf '%s' "$queue" | base64 -w0)"
        printf '%s consumers=%s\n' \
          "$queue" \
          "$(redis-cli -u "$REDIS_URL" --no-raw client list 2>/dev/null \
              | grep -c "name=bull:${queue_b64}" || echo 0)"
        # A job that exhausted its attempts keeps its deterministic id, and BullMQ ignores a
        # later `add` for an id it already holds, so these ids are what silently swallows
        # every replay of the matching plan.
        printf '%s failed_job_ids=%s\n' \
          "$queue" \
          "$(redis-cli -u "$REDIS_URL" zrange "bull:${queue}:failed" 0 -1 2>/dev/null \
              | paste -sd, - || true)"
      done
      printf 'autopilot_meta_keys=%s\n' \
        "$(redis-cli -u "$REDIS_URL" --scan --pattern 'bull:autopilot-plans:*' --count 200 2>/dev/null | wc -l)"
      # Which BullMQ consumers exist at all. The worker builds them in a fixed order, so
      # the set that registered says how far top-level startup actually got.
      printf 'registered_bull_consumers=%s\n' \
        "$(redis-cli -u "$REDIS_URL" --no-raw client list 2>/dev/null \
            | sed -nE 's/.*[[:space:]]name=(bull:[^[:space:]]+).*/\1/p' \
            | sort | uniq -c | awk '{printf "%s(%s) ", $2, $1}' || true)"
    fi
  ) || echo "(redis probe failed)"
fi

section "WEB READINESS (AI capability detail)"
# `aiReady` gates every release: the deploy workflow refuses to ship onto a host that
# reports it false. It is computed from the web process's in-memory provider circuit
# snapshot and demands that *every* engine ever called reports a successful last outcome,
# so one dead engine reached through a fallback keeps production degraded until a restart.
# The engine ids and their last outcome are what explain a red gate.
if [[ -z "$current_path" || ! -f "$current_path/.env.production" ]]; then
  echo "(skipped: no runtime env)"
else
  (
    cd "$current_path"
    set -a
    # shellcheck disable=SC1091
    . ./.env.production
    set +a
    if [[ -z "${AURORA_READINESS_TOKEN:-}" ]]; then
      echo "(skipped: AURORA_READINESS_TOKEN absent)"
      exit 0
    fi
    payload="$(curl -fsS --max-time 10 \
      -H "Authorization: Bearer ${AURORA_READINESS_TOKEN}" \
      http://127.0.0.1:3002/api/readiness 2>/dev/null || true)"
    if [[ -z "$payload" ]]; then
      echo "(readiness request failed)"
      exit 0
    fi
    AURORA_DIAG_READINESS="$payload" node --input-type=module -e '
      const report = JSON.parse(process.env.AURORA_DIAG_READINESS);
      console.log(JSON.stringify({
        status: report.status,
        aiReady: report.aiReady,
        aiConfigured: report.checks?.aiConfigured,
        reasons: report.reasons,
        aiProviders: report.checks?.aiProviders,
      }, null, 2));
    '
  ) | redact || echo "(readiness probe failed)"
fi

section "AI PROVIDER PROBE (bounded, opt-in)"
# Autopilot plans fail with `empty_generation`, which means the provider returned a
# response carrying no visible content. Reasoning-capable models can spend the entire
# output budget before emitting any, so the diagnosis needs the raw finish_reason and
# token accounting per request shape. Prompts and completions are never printed.
if [[ "${AURORA_DIAG_PROBE_PROVIDER:-false}" != "true" ]]; then
  echo "(skipped: set probe_provider=true to spend a few provider calls)"
elif [[ -z "$current_path" || ! -f "$current_path/.env.production" ]]; then
  echo "(skipped: no runtime env)"
else
  (
    cd "$current_path"
    set -a
    # shellcheck disable=SC1091
    . ./.env.production
    set +a
    node --input-type=module -e '
      const key = process.env.NAVYAI_API_KEY || "";
      if (!key) { console.log("NAVYAI_API_KEY absent; probe skipped"); process.exit(0); }
      const messages = [
        { role: "system", content: "Ты редактор Telegram-канала. Пиши по-русски." },
        { role: "user", content: "Напиши один короткий пост (3 предложения) о пользе чек-листов в работе юриста." },
      ];
      // Which model slugs does this account actually serve? A retired slug and a broken
      // account look identical from a single failing completion.
      try {
        const catalog = await fetch("https://api.navy/v1/models", {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(30_000),
        });
        const body = await catalog.json().catch(() => null);
        const ids = (body?.data ?? []).map((entry) => String(entry?.id || "")).filter(Boolean);
        console.log(JSON.stringify({
          catalogStatus: catalog.status,
          modelCount: ids.length,
          auroraEnginesPresent: ["gpt-5.4", "deepseek-v4-pro", "deepseek-v4-flash", "qwen3.6-27b", "minimax-m3"]
            .filter((id) => ids.includes(id)),
          sample: ids.slice(0, 40),
        }));
      } catch (error) {
        console.log(JSON.stringify({ catalogFailure: String(error?.message || error).slice(0, 200) }));
      }

      const variants = [
        { label: "gpt-5.4 (production shape)", model: "gpt-5.4", body: { max_tokens: 3000 } },
        { label: "deepseek-v4-pro effort=none", model: "deepseek-v4-pro", body: { max_tokens: 3000, reasoning_effort: "none" } },
        { label: "deepseek-v4-flash effort=none", model: "deepseek-v4-flash", body: { max_tokens: 3000, reasoning_effort: "none" } },
        { label: "qwen3.6-27b", model: "qwen3.6-27b", body: { max_tokens: 1200 } },
        { label: "minimax-m3", model: "minimax-m3", body: { max_tokens: 1200 } },
      ];
      for (const variant of variants) {
        const started = Date.now();
        try {
          const response = await fetch("https://api.navy/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(45_000),
            body: JSON.stringify({ model: variant.model, temperature: 0.4, messages, ...variant.body }),
          });
          const raw = await response.text();
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { /* keep raw shape below */ }
          const choice = parsed?.choices?.[0];
          const message = choice?.message ?? {};
          console.log(JSON.stringify({
            variant: variant.label,
            httpStatus: response.status,
            elapsedMs: Date.now() - started,
            finishReason: choice?.finish_reason ?? null,
            contentChars: String(message.content ?? "").length,
            reasoningChars: String(message.reasoning ?? message.reasoning_content ?? "").length,
            usage: parsed?.usage ?? null,
            providerError: parsed?.error?.message ? String(parsed.error.message).slice(0, 200) : null,
            unparsedBodyChars: parsed ? null : raw.length,
          }));
        } catch (error) {
          console.log(JSON.stringify({
            variant: variant.label,
            elapsedMs: Date.now() - started,
            failure: String(error?.name || "Error"),
            message: String(error?.message || error).slice(0, 200),
          }));
        }
      }
    ' 2>&1 | redact
  ) || echo "(provider probe failed)"
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
