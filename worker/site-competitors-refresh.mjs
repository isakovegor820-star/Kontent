import { crawlSite } from "../src/lib/site-crawler.mjs";
import {
  SITE_COMPETITOR_CRAWL_LIMITS,
  buildCompetitorSummary,
} from "../src/lib/site-competitors/summary.mjs";

/**
 * Обновляет снимки конкурентов сайта тем же безопасным обходчиком, что обходит сайт клиента.
 *
 * Вызывается после коммита основного анализа и никогда не влияет на его результат:
 * чужой сайт может быть недоступен или запрещать обход — аудит клиента от этого не падает,
 * а конкурент получает статус ошибки с понятным кодом.
 */
export async function refreshSiteCompetitors(pool, input) {
  const siteId = Number(input?.siteId);
  if (!Number.isSafeInteger(siteId) || siteId <= 0) return { updated: 0, failed: 0, skipped: "no_site" };

  const crawl = input.crawl || crawlSite;
  const { rows } = await pool.query(
    "select id, domain, canonical_url from site_competitors where site_id = $1 order by created_at asc, id asc",
    [siteId],
  );
  if (rows.length === 0) return { updated: 0, failed: 0, skipped: "no_competitors" };

  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const output = await crawl({
        targetUrl: row.canonical_url,
        confirmedDomain: row.domain,
        consent: true,
        limits: SITE_COMPETITOR_CRAWL_LIMITS,
      });
      const summary = buildCompetitorSummary({
        domain: row.domain,
        pages: output.pages,
        report: output.report,
      });
      await pool.query(
        `update site_competitors
            set status = 'ready', summary = $3::jsonb, last_error = null,
                crawled_at = now(), updated_at = now()
          where id = $1 and site_id = $2`,
        [row.id, siteId, JSON.stringify(summary)],
      );
      updated += 1;
    } catch (error) {
      const code = String(error?.code || error?.name || "crawl_failed").slice(0, 300);
      await pool.query(
        `update site_competitors
            set status = 'error', last_error = $3, updated_at = now()
          where id = $1 and site_id = $2`,
        [row.id, siteId, code],
      );
      failed += 1;
    }
  }
  return { updated, failed };
}
