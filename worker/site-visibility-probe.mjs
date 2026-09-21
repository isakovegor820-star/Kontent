import { completeAiText } from "../src/lib/ai-completion-service.mjs";
import { configuredAiFallbacks, configuredServiceEngine, isConfiguredEngineId } from "../src/lib/ai-engine-policy.mjs";
import {
  SITE_PROBE_LIMITS,
  buildProbeQuestions,
  extractMentions,
  probeSystemPrompt,
  summarizeProbeRun,
} from "../src/lib/site-probe/questions.mjs";
import { assertWorkerAiCallPolicy } from "./ai-call-policy.mjs";
import {
  WORKER_AI_RESERVATION_TTL_MS,
  acquireWorkerAiUsage,
  commitWorkerAiUsage,
  releaseWorkerAiUsage,
  workerAiUsageCompositeKey,
} from "./ai-usage-reservation.mjs";

export const SITE_PROBE_INTERVAL_DAYS = 30;

export function probeEngines(env = process.env, override = null) {
  const explicit = (override || String(env.SITE_PROBE_ENGINES || "").split(","))
    .map((value) => String(value).trim())
    .filter(isConfiguredEngineId);
  if (explicit.length) return [...new Set(explicit)].slice(0, SITE_PROBE_LIMITS.maxEngines);
  const primary = configuredServiceEngine(null, env);
  const fallbacks = configuredAiFallbacks(primary, env);
  return [...new Set([primary, ...fallbacks])].filter((engine) => engine !== "local").slice(0, SITE_PROBE_LIMITS.maxEngines);
}

export function probeRunKey(date = new Date()) {
  return `run-${date.toISOString().slice(0, 10)}`;
}

async function loadProbeContext(pool, siteId) {
  const site = (await pool.query(
    `select s.id, s.project_id, s.user_id, s.confirmed_domain, s.brand_name, s.verification_state, s.status,
            s.latest_analysis_id, p.topics, p.gaps
       from sites s left join site_profiles p on p.id = s.latest_profile_id
      where s.id = $1`,
    [siteId],
  )).rows[0];
  if (!site) return null;
  let brandName = site.brand_name;
  if (!brandName && site.latest_analysis_id) {
    const organization = (await pool.query(
      `select name from site_analysis_entities
        where analysis_id = $1 and entity_type = 'organization'
        order by case confidence when 'high' then 0 when 'medium' then 1 else 2 end, id limit 1`,
      [site.latest_analysis_id],
    )).rows[0];
    brandName = organization?.name || null;
  }
  const [questions, competitors] = await Promise.all([
    pool.query(
      `select question, occurrences from audience_questions where project_id = $1 and status <> 'dismissed'
        order by occurrences desc, last_seen_at desc limit 12`,
      [site.project_id],
    ),
    pool.query(
      `select distinct coalesce(c.title, c.handle) as name from competitors c
         join channels ch on ch.id = c.channel_id where ch.project_id = $1 limit 40`,
      [site.project_id],
    ),
  ]);
  return {
    site,
    brandName: brandName || site.confirmed_domain.replace(/^www\./u, "").split(".")[0],
    audienceQuestions: questions.rows,
    competitorNames: competitors.rows.map((row) => row.name).filter(Boolean),
  };
}

/**
 * Прогон зонда: одни и те же вопросы × движки, бюджет — одна резервация ai_usage (kind site_probe)
 * с потолком 12 × 3 (решение 13.2). При исчерпании лимита прогон записывается как skipped_budget.
 */
export async function runSiteVisibilityProbe(pool, { siteId, engines = null, now = new Date() }, dependencies = {}) {
  const complete = dependencies.completeAiText || completeAiText;
  const acquire = dependencies.acquireUsage || acquireWorkerAiUsage;
  const commit = dependencies.commitUsage || commitWorkerAiUsage;
  const release = dependencies.releaseUsage || releaseWorkerAiUsage;
  const context = await loadProbeContext(pool, siteId);
  if (!context) return { ok: false, reason: "site_missing" };
  const { site } = context;
  if (site.status !== "active" || site.verification_state !== "verified") return { ok: false, reason: "site_not_verified" };

  const questions = buildProbeQuestions({
    profile: { topics: site.topics || [], gaps: site.gaps || [] },
    brandName: context.brandName,
    domain: site.confirmed_domain,
    audienceQuestions: context.audienceQuestions,
  });
  const engineList = probeEngines(dependencies.env || process.env, engines);
  if (!questions.length || !engineList.length) return { ok: false, reason: questions.length ? "no_engines" : "no_questions" };
  const runKey = dependencies.runKey || probeRunKey(now);

  const insertRow = (question, engine, mention, status) => pool.query(
    `insert into site_visibility_probes
       (site_id, run_key, question_key, question_text, engine, brand_mentioned, site_cited, competitors_mentioned, answer_excerpt, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
     on conflict (site_id, run_key, question_key, engine) do update
       set brand_mentioned = excluded.brand_mentioned, site_cited = excluded.site_cited,
           competitors_mentioned = excluded.competitors_mentioned, answer_excerpt = excluded.answer_excerpt,
           status = excluded.status, checked_at = now()`,
    [siteId, runKey, question.key, question.text, engine, mention?.brandMentioned ?? false, mention?.siteCited ?? false,
      JSON.stringify(mention?.competitors || []), mention?.excerpt || null, status],
  );

  const usage = await acquire(pool, {
    userId: Number(site.user_id),
    kind: "site_probe",
    key: workerAiUsageCompositeKey("site-probe", [String(siteId), runKey]),
    ttlMs: WORKER_AI_RESERVATION_TTL_MS,
  });
  if (usage.state === "committed") return { ok: true, skipped: "already_run", runKey };
  if (usage.state === "limit") {
    for (const question of questions) for (const engine of engineList) await insertRow(question, engine, null, "skipped_budget");
    return { ok: false, reason: "skipped_budget", runKey };
  }
  if (usage.state === "in_progress") return { ok: false, reason: "probe_in_progress", runKey };
  const reservationId = Number(usage.reservationId);
  assertWorkerAiCallPolicy("site-visibility-probe", reservationId);

  const rows = [];
  try {
    for (const question of questions) {
      for (const engine of engineList) {
        let mention = null;
        let status = "answered";
        try {
          const completion = await complete({
            system: probeSystemPrompt(),
            user: question.text,
            engine,
            temperature: 0.2,
            maxTokens: 600,
            providerRequestKey: `site-probe:${siteId}:${runKey}:${question.key}:${engine}`,
          }, { allowFallback: false, timeoutMs: 60_000 });
          mention = extractMentions({ answer: completion.text, brandName: context.brandName, domain: site.confirmed_domain, competitorNames: context.competitorNames });
        } catch {
          status = "failed";
        }
        await insertRow(question, engine, mention, status);
        rows.push({ question_key: question.key, engine, status, brand_mentioned: mention?.brandMentioned ?? false, site_cited: mention?.siteCited ?? false, competitors_mentioned: mention?.competitors || [] });
      }
    }
    await commit(pool, Number(site.user_id), reservationId);
  } catch (error) {
    await release(pool, Number(site.user_id), reservationId).catch(() => undefined);
    throw error;
  }
  return { ok: true, runKey, brandName: context.brandName, ...summarizeProbeRun(rows) };
}

export async function latestProbeSummary(pool, siteId) {
  const latest = (await pool.query(
    `select run_key from site_visibility_probes where site_id = $1 order by checked_at desc limit 1`,
    [siteId],
  )).rows[0];
  if (!latest) return null;
  const rows = (await pool.query(
    `select question_key, engine, status, brand_mentioned, site_cited, competitors_mentioned, checked_at
       from site_visibility_probes where site_id = $1 and run_key = $2`,
    [siteId, latest.run_key],
  )).rows;
  return { runKey: latest.run_key, checkedAt: rows[0]?.checked_at || null, ...summarizeProbeRun(rows) };
}
