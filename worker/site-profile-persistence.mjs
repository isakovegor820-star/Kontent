import { buildSiteProfile } from "../src/lib/site-profile/profile.mjs";
import { buildInitialAuditReport } from "../src/lib/site-report/initial-audit.mjs";

/**
 * Достраивает профиль сайта и стартовый отчёт для прогона анализа, запущенного от имени
 * сайта. Вызывается внутри транзакции сохранения worker'а: если профиль не записался,
 * не публикуется и результат анализа — пользователь не увидит «готово» без отчёта.
 *
 * Возвращает null, если у прогона нет site_id или сайт отключён.
 */
export async function persistSiteProfileForAnalysis(client, {
  analysisId,
  runRevision,
  siteId,
  pages,
  report,
  snapshotHash,
  checkedAt,
  now = new Date(),
}) {
  const id = Number(siteId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const siteRow = await client.query(
    `select id, project_id, confirmed_domain, canonical_url, verification_state, status
       from sites
      where id = $1
      for update`,
    [id],
  );
  const site = siteRow.rows[0];
  if (!site || site.status === "disconnected") return null;

  const profile = buildSiteProfile({
    confirmedDomain: site.confirmed_domain,
    pages,
    report,
    checkedAt,
  });

  const storedProfile = await client.query(
    `insert into site_profiles
       (site_id, analysis_job_id, run_revision, profile_version, page_count, publication_count,
        topics, gaps, technical, linkable_pages, summary)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11)
     on conflict (site_id, analysis_job_id, run_revision) where analysis_job_id is not null do update
       set profile_version = excluded.profile_version, page_count = excluded.page_count,
           publication_count = excluded.publication_count, topics = excluded.topics,
           gaps = excluded.gaps, technical = excluded.technical,
           linkable_pages = excluded.linkable_pages, summary = excluded.summary
     returning id`,
    [
      id,
      analysisId,
      runRevision,
      profile.profileVersion,
      profile.pageCount,
      profile.publicationCount,
      JSON.stringify(profile.topics),
      JSON.stringify(profile.gaps),
      JSON.stringify({
        ...profile.technical,
        questions: profile.questions,
        pageTypeCounts: profile.pageTypeCounts,
        lastPublishedAt: profile.lastPublishedAt,
        checkedAt: profile.checkedAt,
      }),
      JSON.stringify(profile.linkablePages),
      profile.summary,
    ],
  );
  const profileId = Number(storedProfile.rows[0].id);

  const previous = await client.query(
    `select id from site_reports
      where site_id = $1 and status = 'ready'
      order by created_at desc, id desc
      limit 1`,
    [id],
  );
  const previousReportId = previous.rows[0] ? Number(previous.rows[0].id) : null;
  const hasReports = previousReportId !== null;

  const report_ = buildInitialAuditReport({
    site: {
      confirmedDomain: site.confirmed_domain,
      canonicalUrl: site.canonical_url,
      verificationState: site.verification_state,
    },
    profile,
    analysis: { analysisId, runRevision, snapshotHash },
    generatedAt: now,
  });
  const storedReport = await client.query(
    `insert into site_reports
       (site_id, kind, profile_id, previous_report_id, payload, summary_ru, status)
     values ($1, $2, $3, $4, $5::jsonb, $6, 'ready')
     returning id`,
    [
      id,
      hasReports ? "on_demand" : "initial_audit",
      profileId,
      previousReportId,
      JSON.stringify(hasReports ? { ...report_.payload, kind: "on_demand" } : report_.payload),
      report_.summaryRu,
    ],
  );

  await client.query(
    `update sites
        set latest_analysis_id = $2, latest_profile_id = $3, updated_at = now()
      where id = $1`,
    [id, analysisId, profileId],
  );

  return {
    siteId: id,
    profileId,
    reportId: Number(storedReport.rows[0].id),
    reportKind: hasReports ? "on_demand" : "initial_audit",
    pageCount: profile.pageCount,
    gaps: profile.gaps.length,
  };
}
