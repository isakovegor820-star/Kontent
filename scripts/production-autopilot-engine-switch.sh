#!/usr/bin/env bash
# Repoint an Autopilot channel at a different generation engine, and optionally start a
# real weekly build so the change can be verified end to end.
#
# Why this exists: `autopilot_settings.generation_engine` is a per-channel pin that
# overrides every environment default, so a channel pinned to a route that does not answer
# keeps failing no matter how healthy the rest of the fleet is. Production had the two
# enabled channels pinned to DeepSeek V4 Pro, which never answers inside the worker attempt
# budget (63 of 103 provider timeouts in one release window), and a third pinned to GPT-5.4,
# whose upstream answers HTTP 500 on every call.
#
# Scope is deliberately narrow: this touches exactly one column on explicitly named
# channels, prints the row before and after, and never writes anything else. The build it
# can trigger is the same `weekly` cron job the scheduler runs on its own.
set -Eeuo pipefail

CHANNELS="${AURORA_ENGINE_CHANNELS:-}"
ENGINE="${AURORA_ENGINE_ID:-}"
TRIGGER_WEEKLY="${AURORA_TRIGGER_WEEKLY:-false}"

if [[ -z "$CHANNELS" || -z "$ENGINE" ]]; then
  echo "AURORA_ENGINE_CHANNELS and AURORA_ENGINE_ID are required" >&2
  exit 1
fi
if [[ ! "$CHANNELS" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  echo "AURORA_ENGINE_CHANNELS must be a comma-separated list of channel ids" >&2
  exit 1
fi
# Keep this list in sync with AUTOPILOT_ENGINE_OPTIONS. An engine id that the application
# does not recognise would be normalised away at read time, so writing one would look like
# a successful switch and change nothing.
case "$ENGINE" in
  navy-deepseek-flash|navy-minimax-m3|navy-gpt-5-4|navy-qwen-3-6|navy-deepseek-pro) ;;
  *)
    echo "AURORA_ENGINE_ID must be one of the Autopilot engine options" >&2
    exit 1
    ;;
esac

current_path="$(readlink -f /opt/aurora-current || true)"
if [[ -z "$current_path" || ! -f "$current_path/.env.production" ]]; then
  echo "no current release or runtime env" >&2
  exit 1
fi

echo "release=$current_path"
echo "channels=$CHANNELS engine=$ENGINE trigger_weekly=$TRIGGER_WEEKLY"

cd "$current_path"
set -a
# shellcheck disable=SC1091
. ./.env.production
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL absent" >&2
  exit 1
fi

# Single statement, explicit channel list, and the engine passed as a bound parameter so the
# value can never be interpolated into SQL. `returning` is the audit record.
psql "$DATABASE_URL" -X --no-psqlrc --set=ON_ERROR_STOP=1 \
  --set=engine="$ENGINE" --set=channels="{$CHANNELS}" <<'SQL'
\pset format aligned
\echo '--- before ---'
select project_id, channel_id, enabled, generation_engine, updated_at
  from autopilot_settings
 where channel_id = any (:'channels'::int[])
 order by channel_id;

\echo '--- applying ---'
update autopilot_settings
   set generation_engine = :'engine', updated_at = now()
 where channel_id = any (:'channels'::int[])
   and generation_engine is distinct from :'engine'
returning project_id, channel_id, generation_engine;

\echo '--- after ---'
select project_id, channel_id, enabled, generation_engine, updated_at
  from autopilot_settings
 where channel_id = any (:'channels'::int[])
 order by channel_id;
SQL

if [[ "$TRIGGER_WEEKLY" != "true" ]]; then
  echo "(weekly build not requested)"
  exit 0
fi

if [[ -z "${REDIS_URL:-}" ]]; then
  echo "REDIS_URL absent; cannot start a build" >&2
  exit 1
fi

# `weeklyPlans()` is the scheduler's own path: it enqueues one plan per enabled channel and
# is deliberately not run at worker startup, so triggering it here is an explicit one-off.
# A unique job id keeps it from colliding with the scheduled Sunday run.
node --input-type=module -e '
  const { Queue } = await import("bullmq");
  const IORedis = (await import("ioredis")).default;
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue("cron", { connection });
  const jobId = `manual-weekly-${Date.now()}`;
  await queue.add("weekly", {}, { jobId, removeOnComplete: true, removeOnFail: true });
  console.log(JSON.stringify({ enqueued: "weekly", jobId }));
  await queue.close();
  connection.disconnect();
'
