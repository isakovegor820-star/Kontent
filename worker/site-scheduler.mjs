import { createHash, randomUUID } from "node:crypto";

import { normalizeSiteLimits } from "../src/lib/site-crawler.mjs";
import { renderSiteReportMarkdown } from "../src/lib/site-report/export.mjs";
import { buildMonthlyReport } from "../src/lib/site-report/monthly.mjs";
import { SITE_ARTICLE_JOBS, enqueueSiteArticleJob, planSiteArticles, reconcileSitePublication } from "./site-articles-worker.mjs";
import { SITE_PROBE_INTERVAL_DAYS, latestProbeSummary, runSiteVisibilityProbe } from "./site-visibility-probe.mjs";

export const SITE_PROFILE_REFRESH_DAYS = 14;
export const SITE_PROFILE_REFRESH_AFTER_PUBLICATIONS = 5;

function siteAnalysisFingerprint({ targetUrl, confirmedDomain, limits }) {
  return createHash("sha256")
    .update(JSON.stringify({ targetUrl, confirmedDomain, limits: normalizeSiteLimits(limits) }), "utf8")
    .digest("hex");
}

/**
 * Пересборка профиля: раз в 14 дней или после 5 публикаций с момента последнего анализа.
 * Прогон создаётся тем же контрактом, что и из API (site_id, идемпотентный ключ, подтверждение очереди).
 */
export async function refreshStaleSiteProfiles(pool, { siteAnalysisQueue, now = new Date() }) {
  const stale = await pool.query(
    `select s.id, s.project_id, s.user_id, s.confirmed_domain, s.canonical_url, a.completed_at,
            (select count(*) from site_articles ar where ar.site_id = s.id and ar.status = 'published'
                and ar.published_at > coalesce(a.completed_at, to_timestamp(0))) as published_since
       from sites s
       left join site_analysis_jobs a on a.id = s.latest_analysis_id
      where s.status = 'active'
        and not exists (select 1 from site_analysis_jobs r where r.site_id = s.id
                         and r.status in ('queued', 'crawling', 'analyzing', 'planning', 'saving'))
        and (a.id is null or a.completed_at is null
             or a.completed_at < $1::timestamptz - make_interval(days => $2)
             or (select count(*) from site_articles ar where ar.site_id = s.id and ar.status = 'published'
                    and ar.published_at > a.completed_at) >= $3)
      order by a.completed_at nulls first limit 20`,
    [now.toISOString(), SITE_PROFILE_REFRESH_DAYS, SITE_PROFILE_REFRESH_AFTER_PUBLICATIONS],
  );
  let started = 0;
  for (const site of stale.rows) {
    const limits = normalizeSiteLimits({});
    const requestId = randomUUID();
    const key = `site:${site.id}:auto:${now.toISOString().slice(0, 10)}`;
    const inserted = await pool.query(
      `insert into site_analysis_jobs
         (project_id, user_id, request_id, idempotency_key, request_fingerprint, target_url,
          confirmed_domain, consented_at, limits, site_id)
       values ($1, $2, $3, $4, $5, $6, $7, now(), $8::jsonb, $9)
       on conflict (user_id, idempotency_key) do nothing
       returning id, run_revision`,
      [site.project_id, site.user_id, requestId, key,
        siteAnalysisFingerprint({ targetUrl: site.canonical_url, confirmedDomain: site.confirmed_domain, limits }),
        site.canonical_url, site.confirmed_domain, JSON.stringify(limits), site.id],
    );
    const row = inserted.rows[0];
    if (!row || !siteAnalysisQueue) continue;
    try {
      await siteAnalysisQueue.add("analyze", { analysisId: Number(row.id), requestId, runRevision: Number(row.run_revision) }, {
        jobId: `site-analysis-${row.id}-r${row.run_revision}`,
        delay: 1_000,
        attempts: 2,
        backoff: { type: "exponential", delay: 15_000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      });
      await pool.query(`update site_analysis_jobs set queue_confirmed_at = now(), updated_at = now() where id = $1 and status = 'queued'`, [row.id]);
      await pool.query(`update sites set latest_analysis_id = $2, updated_at = now() where id = $1`, [site.id, row.id]);
      started += 1;
    } catch {
      await pool.query(
        `update site_analysis_jobs set status = 'failed', stage = 'failed', error_code = 'queue_unavailable',
                error_message = 'Фоновый анализ временно недоступен.', completed_at = now(), updated_at = now()
          where id = $1 and status = 'queued'`,
        [row.id],
      );
    }
  }
  return { candidates: stale.rows.length, started };
}

export async function planArticlesForAllSites(pool, { siteArticlesQueue }) {
  const sites = await pool.query(
    `select id from sites where status = 'active' and latest_profile_id is not null order by id limit 200`,
  );
  let planned = 0;
  for (const site of sites.rows) {
    try {
      const result = await planSiteArticles(pool, { siteId: Number(site.id) }, { queue: siteArticlesQueue });
      planned += result.planned || 0;
    } catch (error) {
      console.error("[site-daily] планирование материалов не удалось", { siteId: site.id, code: error?.code || error?.name });
    }
  }
  return { sites: sites.rows.length, planned };
}

export async function runDueVisibilityProbes(pool, { now = new Date() } = {}, dependencies = {}) {
  const due = await pool.query(
    `select s.id from sites s
      where s.status = 'active' and s.verification_state = 'verified' and s.latest_profile_id is not null
        and not exists (select 1 from site_visibility_probes p where p.site_id = s.id
                         and p.checked_at > $1::timestamptz - make_interval(days => $2))
      order by s.id limit 50`,
    [now.toISOString(), SITE_PROBE_INTERVAL_DAYS],
  );
  const results = [];
  for (const site of due.rows) {
    try {
      results.push(await runSiteVisibilityProbe(pool, { siteId: Number(site.id), now }, dependencies));
    } catch (error) {
      results.push({ ok: false, siteId: Number(site.id), reason: error?.code || error?.name || "probe_failed" });
    }
  }
  return { due: due.rows.length, results };
}

/** Публикации, зависшие без исхода: неизвестная доставка сверяется, забытые pending — переотправляются. */
export async function reconcileStuckPublications(pool, { siteArticlesQueue }, dependencies = {}) {
  const unverified = await pool.query(
    `select id from site_article_publications
      where status = 'published_unverified' and updated_at < now() - interval '10 minutes'
      order by updated_at limit 50`,
  );
  for (const row of unverified.rows) {
    await reconcileSitePublication(pool, { publicationId: Number(row.id) }, { ...dependencies, queue: siteArticlesQueue }).catch(() => undefined);
  }
  const pending = await pool.query(
    `select id, attempts from site_article_publications
      where status = 'pending' and updated_at < now() - interval '10 minutes'
      order by updated_at limit 50`,
  );
  if (siteArticlesQueue) {
    for (const row of pending.rows) {
      await enqueueSiteArticleJob(siteArticlesQueue, SITE_ARTICLE_JOBS.PUBLISH, { publicationId: Number(row.id) }, { jobId: `site-articles-publish-${row.id}-cron${row.attempts}` }).catch(() => undefined);
    }
  }
  const stuckPublishing = await pool.query(
    `update site_article_publications set status = 'published_unverified', reconcile_state = 'pending', worker_lease_token = null, updated_at = now()
      where status = 'publishing' and updated_at < now() - interval '30 minutes' returning id`,
  );
  return { reconciled: unverified.rows.length, requeued: pending.rows.length, recovered: stuckPublishing.rows.length };
}

export async function runSiteDailyMaintenance(pool, { siteArticlesQueue = null, siteAnalysisQueue = null } = {}, dependencies = {}) {
  const now = dependencies.now || new Date();
  const profiles = await refreshStaleSiteProfiles(pool, { siteAnalysisQueue, now });
  const articles = await planArticlesForAllSites(pool, { siteArticlesQueue });
  const probes = await runDueVisibilityProbes(pool, { now }, dependencies);
  const publications = await reconcileStuckPublications(pool, { siteArticlesQueue }, dependencies);
  const summary = { profiles, articles, probes: { due: probes.due }, publications };
  console.log("[site-daily]", JSON.stringify(summary));
  return summary;
}

function previousMonthPeriod(now) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function profileFromRow(row) {
  const technical = row.technical || {};
  return {
    profileVersion: row.profile_version,
    confirmedDomain: row.confirmed_domain,
    checkedAt: technical.checkedAt || row.profile_created_at,
    pageCount: Number(row.page_count),
    publicationCount: Number(row.publication_count),
    lastPublishedAt: technical.lastPublishedAt || null,
    pageTypeCounts: technical.pageTypeCounts || {},
    topics: row.topics || [],
    gaps: row.gaps || [],
    technical: {
      pagesChecked: Number(technical.pagesChecked || 0),
      failedPages: Number(technical.failedPages || 0),
      seoScore: technical.seoScore ?? null,
      seoStatus: technical.seoStatus ?? null,
      geoScore: technical.geoScore ?? null,
      geoStatus: technical.geoStatus ?? null,
      seoIssues: technical.seoIssues || [],
      geoIssues: technical.geoIssues || [],
      notChecked: technical.notChecked || [],
      orphanCandidates: technical.orphanCandidates ?? null,
    },
    questions: technical.questions || { pagesWithQuestions: 0, answeredPages: 0, faqSchemaPages: 0, unansweredQuestions: 0 },
    linkablePages: row.linkable_pages || [],
    summary: row.summary,
  };
}

/**
 * Ежемесячный отчёт по каждому активному сайту с профилем. Markdown отчёта сразу попадает
 * в базу знаний сайта (kind = site_report), чтобы следующий отчёт видел прошлые рекомендации.
 */
export async function runSiteMonthlyReports(pool, { now = new Date(), period = null, siteId = null, kind = "monthly" } = {}) {
  const window = period || previousMonthPeriod(now);
  const sites = await pool.query(
    `select s.id, s.user_id, s.confirmed_domain, s.canonical_url, s.verification_state,
            p.profile_version, p.page_count, p.publication_count, p.topics, p.gaps, p.technical, p.linkable_pages, p.summary,
            p.created_at as profile_created_at, p.id as profile_id
       from sites s join site_profiles p on p.id = s.latest_profile_id
      where s.status = 'active' and ($1::bigint is null or s.id = $1) order by s.id limit 500`,
    [siteId],
  );
  let created = 0;
  for (const row of sites.rows) {
    if (kind === "monthly") {
      const existing = await pool.query(
        `select id from site_reports where site_id = $1 and kind = 'monthly' and period_start = $2::timestamptz limit 1`,
        [row.id, window.start],
      );
      if (existing.rows[0]) continue;
    }
    const [publications, byTypeRows, previous, probe] = await Promise.all([
      pool.query(
        `select
           count(*) filter (where status = 'published' and published_at >= $2::timestamptz and published_at < $3::timestamptz)::int as published,
           count(*) filter (where status = 'rejected' and status_reason = 'semantic_duplicate' and updated_at >= $2::timestamptz and updated_at < $3::timestamptz)::int as rejected,
           count(*) filter (where status = 'needs_review')::int as pending,
           count(*) filter (where status = 'failed' and updated_at >= $2::timestamptz and updated_at < $3::timestamptz)::int as failed
         from site_articles where site_id = $1`,
        [row.id, window.start, window.end],
      ),
      pool.query(
        `select article_type, count(*)::int as n from site_articles
          where site_id = $1 and status = 'published' and published_at >= $2::timestamptz and published_at < $3::timestamptz
          group by article_type`,
        [row.id, window.start, window.end],
      ),
      pool.query(
        `select id, payload from site_reports where site_id = $1 and status = 'ready' order by created_at desc, id desc limit 1`,
        [row.id],
      ),
      latestProbeSummary(pool, Number(row.id)),
    ]);
    const stats = publications.rows[0] || {};
    const byType = Object.fromEntries(byTypeRows.rows.map((item) => [item.article_type, Number(item.n)]));
    const report = buildMonthlyReport({
      site: { confirmedDomain: row.confirmed_domain, canonicalUrl: row.canonical_url, verificationState: row.verification_state },
      profile: profileFromRow(row),
      period: window,
      publications: { published: Number(stats.published || 0), byType, rejectedDuplicates: Number(stats.rejected || 0), pendingReview: Number(stats.pending || 0), failed: Number(stats.failed || 0) },
      probe: probe ? { ...probe, answers: probe.answers } : null,
      previousReport: previous.rows[0] ? { id: Number(previous.rows[0].id), payload: previous.rows[0].payload } : null,
      generatedAt: now,
      kind,
    });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const stored = await client.query(
        `insert into site_reports (site_id, kind, period_start, period_end, profile_id, previous_report_id, probe_run_key, payload, summary_ru, status)
         values ($1, $9, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7::jsonb, $8, 'ready') returning id`,
        [row.id, window.start, window.end, row.profile_id, previous.rows[0]?.id ?? null, probe?.runKey ?? null, JSON.stringify(report.payload), report.summaryRu, kind],
      );
      const markdown = renderSiteReportMarkdown(report).toString("utf8");
      await client.query(
        `insert into knowledge_sources (user_id, site_id, kind, title, raw_text, status) values ($1, $2, 'site_report', $3, $4, 'pending')`,
        [row.user_id, row.id, `Отчёт за ${window.start.slice(0, 7)} (#${stored.rows[0].id})`, markdown.slice(0, 60_000)],
      );
      await client.query("commit");
      created += 1;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      console.error("[site-monthly] отчёт не сохранён", { siteId: row.id, code: error?.code || error?.name });
    } finally {
      client.release();
    }
  }
  return { sites: sites.rows.length, created, period: window };
}

/** Отчёт по запросу пользователя: последние 30 дней, тип on_demand, та же сборка и та же дельта. */
export async function runSiteReportOnDemand(pool, { siteId, now = new Date() }) {
  const end = now.toISOString();
  const start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  return runSiteMonthlyReports(pool, { now, period: { start, end }, siteId: Number(siteId), kind: "on_demand" });
}
