import { syncPublicMarketSignals } from "./opportunity-market.mjs";

function normalizedQuery(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}_@+.-]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200);
}

/**
 * Schedules bounded, channel-specific public web discovery. The existing Radar worker
 * performs fetch/verification; this coordinator never reads tenant posts into the
 * global market store.
 */
export async function refreshOpportunityMarket(db, queue, now = new Date()) {
  const synchronized = await syncPublicMarketSignals(db);
  if (!queue) return { ...synchronized, scheduled: 0, queueUnavailable: true };
  const profiles = (await db.query(
    `select channel.project_id, channel.id as channel_id,
            coalesce(nullif(btrim(brief.niche), ''), brief.rubrics[1]) as niche,
            brief.rubrics[1] as rubric, brief.opportunity_keywords[1] as keyword,
            member.user_id
       from channels channel
       join content_brief brief on brief.project_id = channel.project_id and brief.channel_id = channel.id
       join lateral (
         select candidate.user_id from project_members candidate
          where candidate.project_id = channel.project_id and candidate.status = 'active'
          order by case candidate.role when 'owner' then 0 when 'author' then 1 else 2 end, candidate.user_id
          limit 1
       ) member on true
      where channel.is_active = true and channel.status = 'active'
        and (nullif(btrim(brief.niche), '') is not null or cardinality(brief.rubrics) > 0)
        and not exists (
          select 1 from radar_search_runs recent
           where recent.project_id = channel.project_id and recent.channel_id = channel.id
             and recent.request_key like 'opportunity-market:%'
             and recent.created_at > now() - interval '6 hours'
             and recent.status in ('queued','running','ready','partial')
        )
      order by channel.id limit 50`,
  )).rows;
  let scheduled = 0;
  const bucket = Math.floor(now.getTime() / (6 * 3_600_000));
  for (const profile of profiles) {
    const query = normalizedQuery([profile.keyword, profile.rubric, profile.niche, "новости тренды"].filter(Boolean).join(" "));
    if (query.length < 2) continue;
    const requestKey = `opportunity-market:${profile.project_id}:${profile.channel_id}:${bucket}`;
    const run = (await db.query(
      `insert into radar_search_runs
         (user_id, channel_id, request_key, query, normalized_query, project_id)
       values ($1,$2,$3,$4,$4,$5)
       on conflict (project_id, user_id, request_key) do nothing returning id`,
      [Number(profile.user_id), Number(profile.channel_id), requestKey, query, Number(profile.project_id)],
    )).rows[0];
    if (!run) continue;
    try {
      await queue.add("radar-search", { runId: Number(run.id), userId: Number(profile.user_id) }, {
        jobId: `radar-search-${run.id}`,
        attempts: 2,
        backoff: { type: "exponential", delay: 12_000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      });
      await db.query("update radar_search_runs set queue_confirmed_at=now(), updated_at=now() where id=$1", [Number(run.id)]);
      scheduled++;
    } catch {
      await db.query(
        `update radar_search_runs set status='failed', stage='failed', progress=100,
                error_code='queue_unavailable', error_message='Фоновый поиск временно недоступен',
                completed_at=now(), updated_at=now() where id=$1`,
        [Number(run.id)],
      ).catch(() => undefined);
    }
  }
  return { ...synchronized, scheduled, queueUnavailable: false };
}
