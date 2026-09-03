import type { Pool, PoolClient } from "pg";

import {
  SITE_DESTINATION_CAPABILITIES,
  createSiteDestinationAdapters,
  deriveHostedSlug,
  destinationRuntime,
  encryptDestinationCredentials,
  hostedSectionOrigin,
  normalizeWordPressCredentials,
  type SiteDestinationAdapter,
  type SiteDestinationKind,
} from "../site-destinations/index.mjs";
import { SiteServiceError, type SiteRow } from "./service";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type SiteDestinationRow = {
  id: string | number;
  site_id: string | number;
  kind: SiteDestinationKind;
  base_url: string;
  credentials: string | null;
  credential_state: string;
  section_path: string | null;
  settings: Record<string, unknown>;
  status: "active" | "needs_reconnect" | "revoked" | "disconnected";
  last_verified_at: Date | string | null;
  last_error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export const SITE_DESTINATION_FIELDS = `id, site_id, kind, base_url, credentials, credential_state, section_path,
  settings, status, last_verified_at, last_error_code, created_at, updated_at`;

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function serializeSiteDestination(row: SiteDestinationRow) {
  const capability = SITE_DESTINATION_CAPABILITIES[row.kind];
  const { hostedSlug, account, ...publicSettings } = (row.settings || {}) as Record<string, unknown>;
  return {
    id: Number(row.id),
    kind: row.kind,
    label: String(capability?.label || row.kind),
    baseUrl: row.base_url,
    credentialState: row.credential_state,
    status: row.status,
    sectionPath: row.section_path,
    settings: publicSettings,
    hostedSlug: typeof hostedSlug === "string" ? hostedSlug : null,
    account: account && typeof account === "object" ? account : null,
    lastVerifiedAt: iso(row.last_verified_at),
    lastErrorCode: row.last_error_code,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    readyToPublish: row.status === "active" && (row.credential_state === "ready" || row.credential_state === "not_required"),
  };
}

export async function listSiteDestinations(db: Queryable, siteId: number) {
  const result = await db.query<SiteDestinationRow>(
    `select ${SITE_DESTINATION_FIELDS} from site_destinations where site_id = $1 order by kind`,
    [siteId],
  );
  return result.rows;
}

let adapters: ReturnType<typeof createSiteDestinationAdapters> | null = null;
export function siteDestinationAdapters(): Readonly<Record<SiteDestinationKind, SiteDestinationAdapter>> {
  if (!adapters) adapters = createSiteDestinationAdapters();
  return adapters;
}

async function ensureHostedSlug(db: Queryable, site: SiteRow): Promise<string> {
  const existing = (site as SiteRow & { hosted_slug?: string | null }).hosted_slug;
  if (existing) return existing;
  const base = deriveHostedSlug(site.confirmed_domain);
  if (!base) throw new SiteServiceError("hosted_slug_unavailable", 422);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base.slice(0, 57)}-${String(Number(site.id)).padStart(4, "0")}${attempt > 1 ? attempt : ""}`;
    const updated = await db.query<{ hosted_slug: string }>(
      `update sites set hosted_slug = $2, updated_at = now()
        where id = $1 and hosted_slug is null
          and not exists (select 1 from sites other where other.hosted_slug = $2)
        returning hosted_slug`,
      [site.id, candidate],
    );
    if (updated.rows[0]) return updated.rows[0].hosted_slug;
    const current = await db.query<{ hosted_slug: string | null }>(`select hosted_slug from sites where id = $1`, [site.id]);
    if (current.rows[0]?.hosted_slug) return current.rows[0].hosted_slug;
  }
  throw new SiteServiceError("hosted_slug_unavailable", 409);
}

/**
 * Настраивает назначение. WordPress проверяется живым запросом к REST API до сохранения:
 * неверные учётные данные не попадают в базу даже в зашифрованном виде.
 */
export async function upsertSiteDestination(db: Queryable, input: {
  site: SiteRow;
  userId: number;
  kind: SiteDestinationKind;
  baseUrl?: unknown;
  credentials?: unknown;
  sectionPath?: unknown;
  adapters?: Readonly<Record<SiteDestinationKind, SiteDestinationAdapter>>;
  env?: Record<string, string | undefined>;
}): Promise<{ row: SiteDestinationRow; verification: Awaited<ReturnType<SiteDestinationAdapter["verify"]>> }> {
  const registry = input.adapters ?? siteDestinationAdapters();
  const siteId = Number(input.site.id);

  if (input.kind === "site_hosted") {
    const hostedSlug = await ensureHostedSlug(db, input.site);
    const origin = hostedSectionOrigin(hostedSlug, input.env ?? process.env);
    if (!origin) throw new SiteServiceError("hosted_domain_not_configured", 503);
    const verification = await registry.site_hosted.verify({
      id: 0, kind: "site_hosted", baseUrl: origin, sectionPath: null, settings: { hostedSlug }, credentials: null,
    });
    const stored = await db.query<SiteDestinationRow>(
      `insert into site_destinations (site_id, kind, base_url, credential_state, settings, status, last_verified_at, last_error_code)
       values ($1, 'site_hosted', $2, 'not_required', $3::jsonb, 'active', now(), null)
       on conflict (site_id, kind) do update
         set base_url = excluded.base_url, settings = excluded.settings, status = 'active',
             credential_state = 'not_required', last_verified_at = now(), last_error_code = null, updated_at = now()
       returning ${SITE_DESTINATION_FIELDS}`,
      [siteId, origin, JSON.stringify({ hostedSlug })],
    );
    return { row: stored.rows[0], verification };
  }

  const credentials = normalizeWordPressCredentials(input.credentials);
  if (!credentials) throw new SiteServiceError("credentials_invalid", 422);
  let baseUrl: string;
  try {
    const url = new URL(String(input.baseUrl || "").trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
    url.hash = "";
    url.search = "";
    baseUrl = url.toString();
  } catch {
    throw new SiteServiceError("base_url_invalid", 422);
  }
  const sectionPath = input.sectionPath === undefined || input.sectionPath === null || input.sectionPath === ""
    ? null
    : String(input.sectionPath).trim().slice(0, 120);

  const verification = await registry.wordpress.verify({
    id: 0, kind: "wordpress", baseUrl, sectionPath, settings: { hostedSlug: null }, credentials,
  });
  if (!verification.ok) {
    throw Object.assign(new SiteServiceError(verification.reason || "destination_verification_failed", 422), { verification });
  }
  const envelope = encryptDestinationCredentials(credentials, { userId: input.userId });
  const stored = await db.query<SiteDestinationRow>(
    `insert into site_destinations (site_id, kind, base_url, credentials, credential_state, section_path, settings, status, last_verified_at, last_error_code)
     values ($1, 'wordpress', $2, $3, 'ready', $4, $5::jsonb, 'active', now(), null)
     on conflict (site_id, kind) do update
       set base_url = excluded.base_url, credentials = excluded.credentials, credential_state = 'ready',
           section_path = excluded.section_path, settings = excluded.settings, status = 'active',
           last_verified_at = now(), last_error_code = null, updated_at = now()
     returning ${SITE_DESTINATION_FIELDS}`,
    [siteId, baseUrl, envelope, sectionPath, JSON.stringify({ account: verification.account ?? null })],
  );
  return { row: stored.rows[0], verification };
}

export async function disconnectSiteDestination(db: Queryable, siteId: number, kind: SiteDestinationKind) {
  const result = await db.query<SiteDestinationRow>(
    `update site_destinations
        set status = 'disconnected', credentials = null,
            credential_state = case when kind = 'wordpress' then 'not_configured' else credential_state end,
            updated_at = now()
      where site_id = $1 and kind = $2
      returning ${SITE_DESTINATION_FIELDS}`,
    [siteId, kind],
  );
  return result.rows[0] ?? null;
}

export function runtimeForDestination(row: SiteDestinationRow, site: SiteRow & { hosted_slug?: string | null }, userId: number) {
  return destinationRuntime(row, { userId, hostedSlug: site.hosted_slug ?? null });
}
