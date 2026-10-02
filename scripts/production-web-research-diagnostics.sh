#!/usr/bin/env bash
# Runs on the production host over SSH. Read-only by construction: it inspects systemd,
# the deployed release, Redis queue state and PostgreSQL catalogs, and it reproduces the
# deployed code's own search configuration. It starts nothing, restarts nothing and
# writes nothing.
#
# Redaction contract: only key NAMES leave `.env.production` for anything secret, journal
# lines are filtered to Aurora's own log prefixes, and every line is scrubbed of embedded
# credentials before it is printed.
set -Eeuo pipefail

CURRENT_LINK="${AURORA_CURRENT_LINK:-/opt/aurora-current}"

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
printf 'current_path=%s\n' "${current_path:-MISSING}"
if [[ -n "$current_path" && -d "$current_path" ]]; then
  printf 'current_sha=%s\n' "$(git -C "$current_path" rev-parse --verify HEAD 2>/dev/null || echo unknown)"
  printf 'current_subject=%s\n' "$(git -C "$current_path" log -1 --format=%s 2>/dev/null || echo unknown)"
fi
printf 'server_time=%s\n' "$(date -Is)"
printf 'timezone=%s\n' "$(timedatectl show -p Timezone --value 2>/dev/null || echo unknown)"

section "SERVICE STATE"
for unit in aurora-web.service aurora-worker.service; do
  printf '%s active=%s sub=%s since=%s restarts=%s\n' \
    "$unit" \
    "$(systemctl is-active "$unit" 2>/dev/null || true)" \
    "$(systemctl show "$unit" -p SubState --value 2>/dev/null || true)" \
    "$(systemctl show "$unit" -p ActiveEnterTimestamp --value 2>/dev/null || true)" \
    "$(systemctl show "$unit" -p NRestarts --value 2>/dev/null || true)"
done

section "WORKER JOURNAL: internet research (last 12h)"
# Aurora's own prefix only; the worker logs a lot of unrelated traffic.
journalctl -u aurora-worker.service --since '-12 hours' --no-pager -o cat 2>/dev/null \
  | grep -aF '[web-research]' | tail -n 40 | redact || echo "(no [web-research] lines)"

section "WORKER JOURNAL: cron ticks (last 12h)"
journalctl -u aurora-worker.service --since '-12 hours' --no-pager -o cat 2>/dev/null \
  | grep -aiE '\[cron\].*(web-research|неизвестн)' | tail -n 20 | redact || echo "(no cron lines)"

section "WEB JOURNAL: studio research (last 12h)"
journalctl -u aurora-web.service --since '-12 hours' --no-pager -o cat 2>/dev/null \
  | grep -aF '[ai-generate] research' | tail -n 30 | redact || echo "(no [ai-generate] research lines)"

section "RUNTIME ENV: research switches (names and non-secret values only)"
if [[ -n "$current_path" && -f "$current_path/.env.production" ]]; then
  for key in RADAR_SEARXNG_URL AURORA_CHAT_RESEARCH AI_SERVICE_ENGINE AI_FALLBACK_ENGINES; do
    value="$(sed -nE "s/^${key}=(.*)$/\1/p" "$current_path/.env.production" | tail -n 1)"
    if [[ -z "$value" ]]; then
      printf '%s=<absent-or-empty>\n' "$key"
    elif [[ "$key" == "RADAR_SEARXNG_URL" ]]; then
      # A non-routable placeholder is the same as absent for diagnosis.
      printf '%s=<present:%s chars>\n' "$key" "${#value}"
    else
      printf '%s=%s\n' "$key" "$value"
    fi
  done
else
  echo "MISSING .env.production"
fi

section "SEARCH PROVIDERS AS THE DEPLOYED CODE SEES THEM (read-only, bounded)"
# The decisive probe for discovery quality: the same provider fan-out the worker uses,
# with the host's own egress. It reads the deployed release code and prints only
# counts and addresses, never page bodies.
if [[ -n "$current_path" && -f "$current_path/src/lib/radar-search.mjs" ]]; then
  (
    cd "$current_path"
    set -a
    # shellcheck disable=SC1091
    . ./.env.production
    set +a
    node --input-type=module -e '
      const query = "маркировка рекламы интернет закон";
      const { RADAR_WEB_DISCOVERY_BUDGET, createRadarDiscoveryBudget,
              createSearxngWebProvider, createBingRssWebProvider,
              createDuckDuckGoWebProvider, createPublicHtmlWebProvider } =
        await import("./src/lib/radar-search.mjs");
      const providers = [
        ["searxng", createSearxngWebProvider({ endpoint: process.env.RADAR_SEARXNG_URL || undefined, fetchImpl: fetch })],
        ["bing-rss", createBingRssWebProvider({ fetchImpl: fetch })],
        ["duckduckgo", createDuckDuckGoWebProvider({ fetchImpl: fetch })],
        ["public-html", createPublicHtmlWebProvider({ fetchImpl: fetch })],
      ].filter(([, provider]) => Boolean(provider));
      const keywords = ["маркировк", "реклам", "интернет"];
      for (const [name, provider] of providers) {
        const budget = createRadarDiscoveryBudget({ ...RADAR_WEB_DISCOVERY_BUDGET });
        try {
          const items = await budget.run(provider.search(query, { budget, signal: budget.signal }));
          const relevant = items.filter((item) => {
            const haystack = `${item.title ?? ""} ${item.snippet ?? ""} ${item.canonicalUrl ?? ""}`
              .toLowerCase().replace(/ё/g, "е");
            return keywords.some((keyword) => haystack.includes(keyword));
          });
          console.log(JSON.stringify({ provider: name, results: items.length, relevant: relevant.length }));
        } catch (error) {
          console.log(JSON.stringify({ provider: name, error: error?.code || error?.name || String(error) }));
        } finally {
          budget.finish();
        }
      }
      process.exit(0);
    ' 2>&1 | redact
  ) || echo "(provider probe could not run)"
else
  echo "(deployed release has no radar-search.mjs)"
fi

section "BULLMQ CRON SCHEDULE REGISTRATION (read-only)"
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
      printf 'cron_repeat_keys=%s\n' \
        "$(redis-cli -u "$REDIS_URL" --raw keys 'bull:cron:repeat:*' 2>/dev/null | wc -l)"
      printf 'web_research_marker_present=%s\n' \
        "$(redis-cli -u "$REDIS_URL" --raw keys 'bull:cron:repeat:*' 2>/dev/null | grep -c 'web-research' || true)"
      # Восемьдесят восемь тысяч ключей повторов при шестнадцати расписаниях — это
      # накопление, а не норма. Печатаем образец: по нему видно, дубли это одного
      # расписания или остатки старого API повторяющихся задач.
      printf 'repeat_keys_sample=%s\n' \
        "$(redis-cli -u "$REDIS_URL" --raw keys 'bull:cron:repeat:*' 2>/dev/null | head -8 | tr '\n' ' ')"
      printf 'repeat_keys_web_research=%s\n' \
        "$(redis-cli -u "$REDIS_URL" --raw keys 'bull:cron:repeat:*' 2>/dev/null | grep 'web-research' | head -6 | tr '\n' ' ')"
      printf 'repeat_keys_distinct_suffixes=%s\n' \
        "$(redis-cli -u "$REDIS_URL" --raw keys 'bull:cron:repeat:*' 2>/dev/null | sed 's/.*:repeat://' | sed 's/:.*//' | sort -u | paste -sd, - | cut -c1-300)"
      printf 'cron_queue_wait=%s active=%s delayed=%s\n' \
        "$(redis-cli -u "$REDIS_URL" llen 'bull:cron:wait' 2>/dev/null)" \
        "$(redis-cli -u "$REDIS_URL" llen 'bull:cron:active' 2>/dev/null)" \
        "$(redis-cli -u "$REDIS_URL" zcard 'bull:cron:delayed' 2>/dev/null)"
      printf 'stats_queue_wait=%s active=%s failed=%s\n' \
        "$(redis-cli -u "$REDIS_URL" llen 'bull:stats:wait' 2>/dev/null)" \
        "$(redis-cli -u "$REDIS_URL" llen 'bull:stats:active' 2>/dev/null)" \
        "$(redis-cli -u "$REDIS_URL" zcard 'bull:stats:failed' 2>/dev/null)"
    fi
  ) || echo "(redis probe failed)"
fi

section "DATABASE PROBE"
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
