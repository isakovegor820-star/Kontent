import type { Pool, PoolClient } from "pg";

import { SITE_COMPETITOR_LIMIT } from "../site-competitors/summary.mjs";

import { SiteServiceError, normalizeSiteInput } from "./service";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export const SITE_COMPETITOR_FIELDS = `id, site_id, project_id, user_id, domain, canonical_url,
  status, last_error, summary, crawled_at, created_at, updated_at`;

export type SiteCompetitorRow = {
  id: string | number;
  site_id: string | number;
  project_id: string | number;
  user_id: string | number;
  domain: string;
  canonical_url: string;
  status: "pending" | "ready" | "error";
  last_error: string | null;
  summary: Record<string, unknown> | null;
  crawled_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function serializeSiteCompetitor(row: SiteCompetitorRow) {
  return {
    id: Number(row.id),
    domain: row.domain,
    canonicalUrl: row.canonical_url,
    status: row.status,
    lastError: row.last_error,
    summary: row.summary ?? null,
    crawledAt: iso(row.crawled_at),
    createdAt: iso(row.created_at),
  };
}

export async function listSiteCompetitors(db: Queryable, siteId: number) {
  const rows = await db.query<SiteCompetitorRow>(
    `select ${SITE_COMPETITOR_FIELDS} from site_competitors
      where site_id = $1
      order by created_at asc, id asc`,
    [siteId],
  );
  return rows.rows.map(serializeSiteCompetitor);
}

/** Добавляет конкурента: домен нормализуется так же строго, как адрес самого сайта. */
export async function addSiteCompetitor(db: Queryable, input: {
  siteId: number;
  projectId: number;
  userId: number;
  url: unknown;
}) {
  const target = normalizeSiteInput(input.url, true);
  const existing = await db.query<SiteCompetitorRow>(
    `select ${SITE_COMPETITOR_FIELDS} from site_competitors where site_id = $1 and domain = $2`,
    [input.siteId, target.confirmedDomain],
  );
  if (existing.rows[0]) return { competitor: serializeSiteCompetitor(existing.rows[0]), created: false };

  const count = await db.query<{ total: string | number }>(
    "select count(*) as total from site_competitors where site_id = $1",
    [input.siteId],
  );
  if (Number(count.rows[0]?.total ?? 0) >= SITE_COMPETITOR_LIMIT) {
    throw new SiteServiceError("competitor_limit", 409);
  }

  const inserted = await db.query<SiteCompetitorRow>(
    `insert into site_competitors (site_id, project_id, user_id, domain, canonical_url)
     values ($1, $2, $3, $4, $5)
     on conflict (site_id, domain) do nothing
     returning ${SITE_COMPETITOR_FIELDS}`,
    [input.siteId, input.projectId, input.userId, target.confirmedDomain, target.canonicalUrl],
  );
  if (inserted.rows[0]) return { competitor: serializeSiteCompetitor(inserted.rows[0]), created: true };

  const raced = await db.query<SiteCompetitorRow>(
    `select ${SITE_COMPETITOR_FIELDS} from site_competitors where site_id = $1 and domain = $2`,
    [input.siteId, target.confirmedDomain],
  );
  if (!raced.rows[0]) throw new SiteServiceError("competitor_insert_race", 503);
  return { competitor: serializeSiteCompetitor(raced.rows[0]), created: false };
}

export async function removeSiteCompetitor(db: Queryable, input: { siteId: number; id: number }) {
  const removed = await db.query<{ id: string | number }>(
    "delete from site_competitors where site_id = $1 and id = $2 returning id",
    [input.siteId, input.id],
  );
  if (!removed.rows[0]) throw new SiteServiceError("competitor_not_found", 404);
  return { removed: true };
}

export async function saveCompetitorSummary(db: Queryable, input: {
  siteId: number;
  domain: string;
  summary: Record<string, unknown>;
  crawledAt?: Date;
}) {
  await db.query(
    `update site_competitors
        set status = 'ready', summary = $3::jsonb, last_error = null,
            crawled_at = $4, updated_at = now()
      where site_id = $1 and domain = $2`,
    [input.siteId, input.domain, JSON.stringify(input.summary), input.crawledAt ?? new Date()],
  );
}

export async function markCompetitorError(db: Queryable, input: { siteId: number; domain: string; code: string }) {
  await db.query(
    `update site_competitors
        set status = 'error', last_error = $3, updated_at = now()
      where site_id = $1 and domain = $2`,
    [input.siteId, input.domain, String(input.code).slice(0, 300)],
  );
}
