// Запускает одно исследование интернета на боевом хосте и, по желанию, дожидается итога.
//
// Нужен для проверки сразу после релиза: плановый обход идёт раз в три часа, и ждать
// его только чтобы узнать, починился ли выход в сеть, бессмысленно. Скрипт исполняется
// кодом развёрнутого релиза, поэтому проверяет ровно то, что работает в бою.
//
// Пишет ровно одну строку запуска и ставит ровно одну задачу в очередь — ничего не
// перезапускает и не меняет настройки. Запускается только явным действием оператора.

import { Queue } from "bullmq";
import { Pool } from "pg";

import { startWebResearchRun } from "../src/lib/web-research-store.mjs";
import { planWebResearch } from "../src/lib/web-research-plan.mjs";

const QUEUE_NAME = "stats";
const waitSeconds = Math.max(0, Math.min(300, Number(process.env.AURORA_TRIGGER_WAIT_SECONDS) || 0));
const requestedChannelId = Number(process.env.AURORA_TRIGGER_CHANNEL_ID) || null;

function redisConnectionOptions(url) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: parsed.pathname && parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const queue = new Queue(QUEUE_NAME, { connection: redisConnectionOptions(process.env.REDIS_URL) });

try {
  // Канал выбирается тем же условием, что и плановый обход: активный телеграм-канал
  // с заполненным брифом. Предпочтение отдаётся тому, кого давно не обходили.
  const candidates = (await pool.query(
    `select channel.project_id, channel.id as channel_id, channel.user_id,
            nullif(btrim(brief.niche), '') as niche,
            coalesce(brief.rubrics, '{}'::text[]) as rubrics,
            coalesce(brief.opportunity_keywords, '{}'::text[]) as opportunity_keywords,
            (select max(recent.started_at) from web_research_runs recent
              where recent.project_id = channel.project_id and recent.channel_id = channel.id) as last_run
       from channels channel
       join content_brief brief on brief.project_id = channel.project_id and brief.channel_id = channel.id
      where channel.status = 'active'
        and channel.network = 'tg'
        and (nullif(btrim(brief.niche), '') is not null or cardinality(brief.rubrics) > 0)
        and ($1::bigint is null or channel.id = $1::bigint)
      order by last_run asc nulls first, channel.id
      limit 1`,
    [requestedChannelId],
  )).rows;

  const target = candidates[0];
  if (!target) {
    console.log(JSON.stringify({ triggered: false, reason: "no_eligible_channel" }));
    process.exit(0);
  }

  const topic = [
    target.niche,
    ...(Array.isArray(target.rubrics) ? target.rubrics.slice(0, 3) : []),
    ...(Array.isArray(target.opportunity_keywords) ? target.opportunity_keywords.slice(0, 3) : []),
  ].filter(Boolean).join(" ").slice(0, 400);

  const plan = planWebResearch({ topic, categories: ["law", "benchmark"], language: "ANY" });
  const runId = await startWebResearchRun(
    pool,
    { projectId: Number(target.project_id), channelId: Number(target.channel_id) },
    {
      triggerKind: "manual",
      topic: plan.topic,
      categories: plan.categories,
      language: plan.language,
      planFingerprint: plan.fingerprint,
      queries: plan.queries,
    },
  );

  const jobId = `web-research-${runId}`;
  await queue.add("web-research", { runId }, {
    jobId,
    attempts: 1,
    removeOnComplete: 200,
    removeOnFail: 200,
  });

  console.log(JSON.stringify({
    triggered: true,
    runId,
    jobId,
    channelId: Number(target.channel_id),
    topic: plan.topic,
    queries: plan.queries.map((query) => query.text),
  }));

  if (waitSeconds > 0) {
    const startedAt = Date.now();
    let final = null;
    while (Date.now() - startedAt < waitSeconds * 1000) {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const row = (await pool.query(
        `select status, findings_count, rejections_count, stats, error
           from web_research_runs where id = $1`,
        [runId],
      )).rows[0];
      if (row && row.status !== "running") {
        final = row;
        break;
      }
    }
    if (!final) {
      console.log(JSON.stringify({ runId, waited: true, outcome: "still_running", waitedSeconds: waitSeconds }));
    } else {
      const rejections = final.stats?.rejections;
      const codes = {};
      for (const rejection of Array.isArray(rejections) ? rejections : []) {
        const code = String(rejection?.code ?? "unknown");
        codes[code] = (codes[code] || 0) + 1;
      }
      const findings = (await pool.query(
        `select left(claim, 90) as claim, source_domain, source_tier,
                to_char(published_at, 'YYYY-MM-DD') as published
           from web_research_findings where run_id = $1 order by source_trust desc limit 5`,
        [runId],
      )).rows;
      console.log(JSON.stringify({
        runId,
        outcome: final.status,
        findings: Number(final.findings_count) || 0,
        rejections: Number(final.rejections_count) || 0,
        rejectionCodes: codes,
        queries: final.stats?.queries ?? null,
        pages: final.stats?.pages ?? null,
        candidates: final.stats?.candidates ?? null,
        spentMs: final.stats?.spentMs ?? null,
        error: final.error ?? null,
        sample: findings,
      }, null, 2));
    }
  }
} finally {
  await queue.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
