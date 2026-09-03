import type { Pool, PoolClient } from "pg";

import { serializeSiteAnalysis, siteAnalysisFingerprint, type SiteAnalysisRow } from "../site-analysis";
import { enqueueSiteAnalysis, hasSiteAnalysisWorker } from "../site-analysis-queue";
import { SiteCrawlerError, normalizeSiteLimits, normalizeSiteTarget } from "../site-crawler.mjs";
import { hostedSectionOrigin } from "../site-destinations/index.mjs";
import {
  generateSiteVerificationToken,
  siteVerificationInstructions,
  type SiteVerificationMethod,
} from "./verification";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export const SITE_ANALYSIS_FIELDS = `id, request_id, target_url, confirmed_domain, status, stage,
  progress, progress_detail, limits, error_code, error_message, attempts,
  run_revision, queue_confirmed_at, created_at, updated_at, completed_at,
  prompt_version, question_catalog_version, snapshot_hash, coverage_mode,
  answered_count, question_count, site_id`;

export type SiteRow = {
  id: string | number;
  project_id: string | number;
  user_id: string | number;
  confirmed_domain: string;
  canonical_url: string;
  verification_state: "unverified" | "verified" | "revoked";
  verification_method: SiteVerificationMethod | null;
  verification_token: string;
  verified_at: Date | string | null;
  latest_analysis_id: string | number | null;
  latest_profile_id: string | number | null;
  publishing_mode: "confirm" | "auto";
  auto_unlock_streak: string | number;
  approved_streak: string | number;
  cadence: Record<string, unknown>;
  status: "active" | "paused" | "disconnected";
  hosted_slug: string | null;
  brand_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type SiteProfileRow = {
  id: string | number;
  site_id: string | number;
  analysis_job_id: string | number | null;
  run_revision: string | number;
  profile_version: string;
  page_count: string | number;
  publication_count: string | number;
  topics: unknown[];
  gaps: unknown[];
  technical: Record<string, unknown>;
  linkable_pages: unknown[];
  summary: string | null;
  created_at: Date | string;
};

export type SiteReportRow = {
  id: string | number;
  site_id: string | number;
  kind: "initial_audit" | "monthly" | "on_demand";
  profile_id: string | number | null;
  previous_report_id: string | number | null;
  payload?: Record<string, unknown>;
  summary_ru: string;
  status: "generating" | "ready" | "failed";
  created_at: Date | string;
};

export const SITE_FIELDS = `id, project_id, user_id, confirmed_domain, canonical_url, verification_state,
  verification_method, verification_token, verified_at, latest_analysis_id, latest_profile_id,
  publishing_mode, auto_unlock_streak, approved_streak, cadence, status, hosted_slug, brand_name, created_at, updated_at`;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function serializeSite(row: SiteRow) {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    confirmedDomain: row.confirmed_domain,
    canonicalUrl: row.canonical_url,
    verification: {
      state: row.verification_state,
      method: row.verification_method,
      verifiedAt: iso(row.verified_at),
      token: row.verification_token,
      instructions: siteVerificationInstructions(row.confirmed_domain, row.verification_token),
    },
    publishingMode: row.publishing_mode,
    autoUnlockStreak: Number(row.auto_unlock_streak),
    approvedStreak: Number(row.approved_streak),
    autoModeUnlocked: Number(row.approved_streak) >= Number(row.auto_unlock_streak),
    cadence: row.cadence ?? {},
    status: row.status,
    hostedSlug: row.hosted_slug,
    hostedOrigin: hostedSectionOrigin(row.hosted_slug),
    brandName: row.brand_name,
    latestAnalysisId: row.latest_analysis_id === null ? null : Number(row.latest_analysis_id),
    latestProfileId: row.latest_profile_id === null ? null : Number(row.latest_profile_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function serializeSiteProfile(row: SiteProfileRow) {
  return {
    id: Number(row.id),
    analysisId: row.analysis_job_id === null ? null : Number(row.analysis_job_id),
    runRevision: Number(row.run_revision),
    profileVersion: row.profile_version,
    pageCount: Number(row.page_count),
    publicationCount: Number(row.publication_count),
    topics: row.topics,
    gaps: row.gaps,
    technical: row.technical,
    linkablePages: row.linkable_pages,
    summary: row.summary,
    createdAt: iso(row.created_at),
  };
}

export function serializeSiteReport(row: SiteReportRow, includePayload = false) {
  return {
    id: Number(row.id),
    kind: row.kind,
    status: row.status,
    profileId: row.profile_id === null ? null : Number(row.profile_id),
    previousReportId: row.previous_report_id === null ? null : Number(row.previous_report_id),
    summaryRu: row.summary_ru,
    createdAt: iso(row.created_at),
    ...(includePayload ? { payload: row.payload ?? null } : {}),
  };
}

export class SiteServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "SiteServiceError";
    this.code = code;
    this.status = status;
  }
}

/** Нормализует адрес сайта по тем же правилам, что и анализ: только https/http, публичный домен. */
export function normalizeSiteInput(url: unknown, consent: unknown) {
  let hostname: string;
  try {
    hostname = new URL(String(url ?? "").trim()).hostname;
  } catch {
    throw new SiteCrawlerError("bad_url", "Некорректный адрес сайта");
  }
  const target = normalizeSiteTarget(url, hostname, consent);
  const canonical = new URL(target.toString());
  canonical.pathname = "/";
  canonical.search = "";
  canonical.hash = "";
  return { confirmedDomain: canonical.hostname.toLowerCase(), canonicalUrl: canonical.toString() };
}

export async function findSiteForProject(db: Queryable, siteId: number, projectId: number): Promise<SiteRow | null> {
  const result = await db.query<SiteRow>(
    `select ${SITE_FIELDS} from sites where id = $1 and project_id = $2`,
    [siteId, projectId],
  );
  return result.rows[0] ?? null;
}

export async function createSite(db: Queryable, input: {
  projectId: number;
  userId: number;
  confirmedDomain: string;
  canonicalUrl: string;
}): Promise<{ site: SiteRow; created: boolean }> {
  const inserted = await db.query<SiteRow>(
    `insert into sites (project_id, user_id, confirmed_domain, canonical_url, verification_token)
     values ($1, $2, $3, $4, $5)
     on conflict (project_id, confirmed_domain) do nothing
     returning ${SITE_FIELDS}`,
    [input.projectId, input.userId, input.confirmedDomain, input.canonicalUrl, generateSiteVerificationToken()],
  );
  if (inserted.rows[0]) return { site: inserted.rows[0], created: true };
  const existing = await db.query<SiteRow>(
    `select ${SITE_FIELDS} from sites where project_id = $1 and confirmed_domain = $2`,
    [input.projectId, input.confirmedDomain],
  );
  if (!existing.rows[0]) throw new SiteServiceError("site_insert_race", 503);
  return { site: existing.rows[0], created: false };
}

/**
 * Запускает прогон анализа от имени сайта. Ключ идемпотентности привязан к сайту и
 * клиентскому ключу, чтобы двойной клик не создавал два прогона.
 */
export async function startSiteAnalysis(pool: Pool, input: {
  site: SiteRow;
  userId: number;
  requestId: string;
  clientKey: string;
}): Promise<{ analysis: ReturnType<typeof serializeSiteAnalysis>; replayed: boolean }> {
  const projectId = Number(input.site.project_id);
  const siteId = Number(input.site.id);
  const limits = normalizeSiteLimits({});
  const fingerprint = siteAnalysisFingerprint({
    targetUrl: input.site.canonical_url,
    confirmedDomain: input.site.confirmed_domain,
    limits,
  });
  const scopedKey = `site:${siteId}:${input.clientKey}`;

  const existing = await pool.query<SiteAnalysisRow & { request_fingerprint: string }>(
    `select ${SITE_ANALYSIS_FIELDS}, request_fingerprint
       from site_analysis_jobs
      where project_id = $1 and user_id = $2 and idempotency_key = $3`,
    [projectId, input.userId, scopedKey],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].request_fingerprint !== fingerprint) throw new SiteServiceError("idempotency_conflict", 409);
    return { analysis: serializeSiteAnalysis(existing.rows[0]), replayed: true };
  }

  const running = await pool.query<{ id: string | number }>(
    `select id from site_analysis_jobs
      where site_id = $1 and status in ('queued', 'crawling', 'analyzing', 'planning', 'saving')
      limit 1`,
    [siteId],
  );
  if (running.rows[0]) throw new SiteServiceError("analysis_in_progress", 409);

  if (!(await hasSiteAnalysisWorker())) throw new SiteServiceError("worker_unavailable", 503);

  const inserted = await pool.query<SiteAnalysisRow>(
    `insert into site_analysis_jobs
       (project_id, user_id, request_id, idempotency_key, request_fingerprint, target_url,
        confirmed_domain, consented_at, limits, site_id)
     values ($1, $2, $3, $4, $5, $6, $7, now(), $8::jsonb, $9)
     on conflict (user_id, idempotency_key) do nothing
     returning ${SITE_ANALYSIS_FIELDS}`,
    [
      projectId, input.userId, input.requestId, scopedKey, fingerprint,
      input.site.canonical_url, input.site.confirmed_domain, JSON.stringify(limits), siteId,
    ],
  );
  let row = inserted.rows[0];
  if (!row) {
    const raced = await pool.query<SiteAnalysisRow & { request_fingerprint: string }>(
      `select ${SITE_ANALYSIS_FIELDS}, request_fingerprint
         from site_analysis_jobs
        where project_id = $1 and user_id = $2 and idempotency_key = $3`,
      [projectId, input.userId, scopedKey],
    );
    if (!raced.rows[0]) throw new SiteServiceError("site_analysis_insert_race", 503);
    if (raced.rows[0].request_fingerprint !== fingerprint) throw new SiteServiceError("idempotency_conflict", 409);
    return { analysis: serializeSiteAnalysis(raced.rows[0]), replayed: true };
  }

  try {
    await enqueueSiteAnalysis({
      analysisId: Number(row.id),
      requestId: row.request_id,
      runRevision: Number(row.run_revision),
    });
    const confirmed = await pool.query<SiteAnalysisRow>(
      `update site_analysis_jobs
          set queue_confirmed_at = now(), updated_at = now()
        where id = $1 and status = 'queued' and run_revision = $2
        returning ${SITE_ANALYSIS_FIELDS}`,
      [row.id, row.run_revision],
    );
    row = confirmed.rows[0] || row;
  } catch {
    await pool.query(
      `update site_analysis_jobs
          set status = 'failed', stage = 'failed', error_code = 'queue_unavailable',
              error_message = 'Фоновый анализ временно недоступен.', completed_at = now(), updated_at = now()
        where id = $1 and status = 'queued' and run_revision = $2`,
      [row.id, row.run_revision],
    );
    throw new SiteServiceError("queue_unavailable", 503);
  }

  await pool.query(
    `update sites set latest_analysis_id = $2, updated_at = now() where id = $1`,
    [siteId, row.id],
  );
  return { analysis: serializeSiteAnalysis(row), replayed: false };
}

export async function loadSiteDetails(db: Queryable, site: SiteRow) {
  const siteId = Number(site.id);
  const [analysis, profile, reports] = await Promise.all([
    db.query<SiteAnalysisRow>(
      `select ${SITE_ANALYSIS_FIELDS}
         from site_analysis_jobs
        where site_id = $1
        order by created_at desc, id desc
        limit 1`,
      [siteId],
    ),
    site.latest_profile_id === null
      ? Promise.resolve({ rows: [] as SiteProfileRow[] })
      : db.query<SiteProfileRow>(
        `select id, site_id, analysis_job_id, run_revision, profile_version, page_count,
                publication_count, topics, gaps, technical, linkable_pages, summary, created_at
           from site_profiles
          where id = $1 and site_id = $2`,
        [site.latest_profile_id, siteId],
      ),
    db.query<SiteReportRow>(
      `select id, site_id, kind, profile_id, previous_report_id, summary_ru, status, created_at
         from site_reports
        where site_id = $1
        order by created_at desc, id desc
        limit 24`,
      [siteId],
    ),
  ]);
  return {
    site: serializeSite(site),
    latestAnalysis: analysis.rows[0] ? serializeSiteAnalysis(analysis.rows[0]) : null,
    profile: profile.rows[0] ? serializeSiteProfile(profile.rows[0]) : null,
    reports: reports.rows.map((row) => serializeSiteReport(row)),
  };
}

export async function listSitesForProject(db: Queryable, projectId: number) {
  const sites = await db.query<SiteRow & {
    analysis_status: string | null;
    analysis_progress: string | number | null;
    profile_summary: string | null;
    profile_page_count: string | number | null;
    profile_gap_count: string | number | null;
    report_count: string | number | null;
  }>(
    `select s.*, a.status as analysis_status, a.progress as analysis_progress,
            p.summary as profile_summary, p.page_count as profile_page_count,
            jsonb_array_length(p.gaps) as profile_gap_count,
            (select count(*) from site_reports r where r.site_id = s.id and r.status = 'ready') as report_count
       from sites s
       left join site_analysis_jobs a on a.id = s.latest_analysis_id
       left join site_profiles p on p.id = s.latest_profile_id
      where s.project_id = $1
      order by s.created_at desc, s.id desc
      limit 50`,
    [projectId],
  );
  return sites.rows.map((row) => ({
    ...serializeSite(row),
    latestAnalysis: row.analysis_status
      ? { status: row.analysis_status, progress: Number(row.analysis_progress ?? 0) }
      : null,
    profile: row.profile_summary !== null || row.profile_page_count !== null
      ? {
          summary: row.profile_summary,
          pageCount: Number(row.profile_page_count ?? 0),
          gapCount: Number(row.profile_gap_count ?? 0),
        }
      : null,
    reportCount: Number(row.report_count ?? 0),
  }));
}
