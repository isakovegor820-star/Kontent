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
FORCE_BUILD="${AURORA_FORCE_BUILD:-false}"

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

if [[ "$FORCE_BUILD" == "true" ]]; then
  if [[ -z "${REDIS_URL:-}" ]]; then
    echo "REDIS_URL absent; cannot start a build" >&2
    exit 1
  fi
  # The scheduler refuses a channel whose newest plan already covers more than seven days,
  # and it logs nothing when it does, so a channel holding a stale `pending` plan can never
  # be rebuilt from the server side. This reproduces exactly what the "build plan" button
  # does: supersede any placeholder, insert a fresh `building` row owned by a human request,
  # and enqueue the same deterministic job id. The real modules are imported rather than the
  # post-count arithmetic reimplemented, so the placeholder cannot disagree with the worker.
  AURORA_FORCE_BUILD_CHANNELS="$CHANNELS" node --input-type=module -e '
    const pg = await import("pg");
    const Pool = pg.default?.Pool ?? pg.Pool;
    const { Queue } = await import("bullmq");
    const IORedis = (await import("ioredis")).default;
    const { plannedPostCountForWeeks, normalizePlanningWeeks, normalizeAutopilotEngine } =
      await import("./src/lib/autopilot-config.mjs");
    const { autopilotCandidateCount } =
      await import("./src/lib/autopilot-candidate-selection.mjs");
    const { AUTOPILOT_JOB_ATTEMPTS, AUTOPILOT_JOB_BACKOFF_MS } =
      await import("./src/lib/autopilot-config.mjs");

    const channels = String(process.env.AURORA_FORCE_BUILD_CHANNELS)
      .split(",").map((value) => Number(value.trim())).filter(Number.isSafeInteger);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    const queue = new Queue("autopilot-plans", { connection });

    for (const channelId of channels) {
      const settings = (await pool.query(
        `select project_id, channel_id, user_id, post_frequency, planning_weeks,
                planning_months, generation_engine, quick_settings, enabled
           from autopilot_settings where channel_id = $1`,
        [channelId],
      )).rows[0];
      if (!settings) { console.log(JSON.stringify({ channelId, skipped: "no_settings" })); continue; }

      const planningWeeks = normalizePlanningWeeks(
        settings.planning_weeks ?? Number(settings.planning_months || 1) * 4,
      );
      const planningMonths = Math.max(1, Math.min(3, Math.ceil(planningWeeks / 4)));
      const frequency = Math.max(1, Math.min(7, Math.round(Number(settings.post_frequency) || 5)));
      const engine = normalizeAutopilotEngine(settings.generation_engine);
      const publicationTargetCount = plannedPostCountForWeeks(frequency, planningWeeks);
      const candidateCount = autopilotCandidateCount(publicationTargetCount);

      const tx = await pool.connect();
      let planId = null;
      try {
        await tx.query("begin");
        await tx.query(
          `select 1 from autopilot_settings where project_id = $1 and channel_id = $2 for update`,
          [settings.project_id, channelId],
        );
        await tx.query(
          `update autopilot_plan
              set status = \x27error\x27, rules = \x27cancelled\x27, terminal_outcome = \x27cancelled\x27,
                  revision = revision + 1
            where project_id = $1 and channel_id = $2 and status = \x27building\x27`,
          [settings.project_id, channelId],
        );
        await tx.query(
          `delete from autopilot_plan
            where project_id = $1 and channel_id = $2 and status = \x27building\x27`,
          [settings.project_id, channelId],
        );
        const inserted = await tx.query(
          `insert into autopilot_plan
              (project_id, user_id, channel_id, week_start, status, generation_engine,
               generation_post_frequency, expected_post_count, publication_target_count,
               candidate_count, planning_months, planning_weeks,
               quick_settings, build_report, build_activity_at)
             values ($1, $2, $3, current_date, \x27building\x27, $4, $5, $6, $6, $7, $8, $9,
                     $10::jsonb, \x27{"requestedBy":"human"}\x27::jsonb, now())
             returning id`,
          [
            settings.project_id, settings.user_id, channelId, engine, frequency,
            publicationTargetCount, candidateCount, planningMonths, planningWeeks,
            JSON.stringify(settings.quick_settings ?? {}),
          ],
        );
        planId = Number(inserted.rows[0].id);
        await tx.query("commit");
      } catch (error) {
        await tx.query("rollback").catch(() => {});
        console.log(JSON.stringify({ channelId, failed: String(error?.message || error).slice(0, 200) }));
        tx.release();
        continue;
      }
      tx.release();

      await queue.add(
        "autopilot-plan",
        { projectId: settings.project_id, userId: settings.user_id, channelId, planId },
        {
          jobId: `autopilot-plan-${planId}`,
          removeOnComplete: true,
          attempts: AUTOPILOT_JOB_ATTEMPTS,
          backoff: { type: "fixed", delay: AUTOPILOT_JOB_BACKOFF_MS },
        },
      );
      console.log(JSON.stringify({
        channelId, planId, engine, publicationTargetCount, candidateCount, planningWeeks,
        enqueued: `autopilot-plan-${planId}`,
      }));
    }

    await queue.close();
    connection.disconnect();
    await pool.end();
  '
fi

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
