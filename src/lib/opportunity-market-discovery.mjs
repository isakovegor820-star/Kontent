import { syncPublicMarketSignals } from "./opportunity-market.mjs";

function normalizedQuery(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}_@+.-]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200);
}

function normalizedTerms(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => normalizedQuery(item))
    .filter((item) => item.length >= 2);
}

/**
 * Three deliberately different searches prevent one broad phrase from defining the
 * whole channel feed: current events, growing discussion and practical audience need.
 */
export function buildOpportunityDiscoveryQueries(profile) {
  const niche = normalizedQuery(profile?.niche);
  const rubrics = normalizedTerms(profile?.rubrics).slice(0, 3);
  const keywords = normalizedTerms(profile?.keywords).slice(0, 4);
  const subject = [keywords[0], rubrics[0], niche].filter(Boolean).join(" ");
  const widerSubject = [niche, ...rubrics.slice(0, 2), ...keywords.slice(0, 2)]
    .filter(Boolean).join(" ");
  const raw = [
    { family: "current", query: `${subject} последние новости изменения` },
    { family: "rising", query: `${widerSubject} тренды обсуждения что набирает популярность` },
    { family: "needs", query: `${subject} вопросы проблемы кейсы практический опыт` },
  ];
  const seen = new Set();
  return raw.flatMap(({ family, query }) => {
    const normalized = normalizedQuery(query);
    if (normalized.length < 2 || seen.has(normalized)) return [];
    seen.add(normalized);
    return [{ family, query: normalized }];
  });
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
            brief.rubrics, brief.opportunity_keywords as keywords,
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
    for (const discovery of buildOpportunityDiscoveryQueries(profile)) {
      const requestKey = `opportunity-market:${profile.project_id}:${profile.channel_id}:${bucket}:${discovery.family}`;
      const run = (await db.query(
        `insert into radar_search_runs
           (user_id, channel_id, request_key, query, normalized_query, project_id)
         values ($1,$2,$3,$4,$4,$5)
         on conflict (project_id, user_id, request_key) do nothing returning id`,
        [Number(profile.user_id), Number(profile.channel_id), requestKey, discovery.query, Number(profile.project_id)],
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
  }
  return { ...synchronized, scheduled, queueUnavailable: false };
}
