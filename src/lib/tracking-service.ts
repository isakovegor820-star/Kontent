import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Pool, PoolClient } from "pg";

import { ProjectAccessError, requireSelectedProjectPermission } from "./project-permissions";
import {
  buildTrackedDestination,
  classifyLikelyBot,
  clickDedupeKey,
  conversionIdempotencyHash,
  createShortLinkSlug,
  normalizeTrackingDestination,
  normalizeUtmValues,
  signAttribution,
  verifyAttribution,
  visitorFingerprint,
  type UtmValues,
} from "./tracked-links";

type Queryable = Pick<PoolClient, "query">;
type TransactionPool = Pick<Pool, "connect">;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{20,64}$/u;
const EVENT_TYPES = ["form_open", "form_submit", "consultation_booked"] as const;

export type ConversionEventType = (typeof EVENT_TYPES)[number];

export class TrackingServiceError extends Error {
  readonly code:
    | "invalid_name"
    | "invalid_template"
    | "invalid_destination"
    | "invalid_utm"
    | "invalid_expiry"
    | "invalid_idempotency_key"
    | "idempotency_conflict"
    | "invalid_origin"
    | "invalid_window"
    | "invalid_public_key"
    | "invalid_attribution"
    | "invalid_event"
    | "tracker_not_connected"
    | "verification_unavailable"
    | "not_found"
    | "version_conflict"
    | "link_unavailable";

  constructor(code: TrackingServiceError["code"]) {
    super(code);
    this.name = "TrackingServiceError";
    this.code = code;
  }
}

function positiveId(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

function hashCanonical(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function normalizeName(value: unknown) {
  const name = String(value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ");
  if (name.length < 1 || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new TrackingServiceError("invalid_name");
  }
  return name;
}

function normalizeIdempotencyKey(value: unknown) {
  const key = String(value ?? "").trim();
  if (!IDEMPOTENCY_KEY.test(key)) throw new TrackingServiceError("invalid_idempotency_key");
  return key;
}

function normalizeUtm(input: unknown): UtmValues {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    if (input == null) return {};
    throw new TrackingServiceError("invalid_utm");
  }
  try {
    return normalizeUtmValues(input as UtmValues);
  } catch {
    throw new TrackingServiceError("invalid_utm");
  }
}

function normalizeDestination(input: unknown) {
  try {
    return normalizeTrackingDestination(String(input ?? ""));
  } catch {
    throw new TrackingServiceError("invalid_destination");
  }
}

function normalizeExpiry(input: unknown, now: Date): Date | null {
  if (input == null || input === "") return null;
  const expiresAt = new Date(String(input));
  if (
    Number.isNaN(expiresAt.getTime())
    || expiresAt.getTime() <= now.getTime() + 60_000
    || expiresAt.getTime() > now.getTime() + 366 * 24 * 60 * 60 * 1_000
  ) throw new TrackingServiceError("invalid_expiry");
  return expiresAt;
}

function explicitlyAllowedLocalOrigin(value: unknown) {
  try {
    return localVerificationOrigins().has(new URL(String(value ?? "")).origin);
  } catch {
    return false;
  }
}

export function normalizeTrackerOrigin(
  value: unknown,
  allowLocal = process.env.NODE_ENV !== "production" || explicitlyAllowedLocalOrigin(value),
) {
  const raw = String(value ?? "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TrackingServiceError("invalid_origin");
  }
  if (!(url.protocol === "http:" || url.protocol === "https:") || url.username || url.password) {
    throw new TrackingServiceError("invalid_origin");
  }
  if (url.pathname !== "/" || url.search || url.hash) throw new TrackingServiceError("invalid_origin");
  const hostname = url.hostname.toLowerCase();
  const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  if (local) {
    if (!allowLocal || url.protocol !== "http:") throw new TrackingServiceError("invalid_origin");
  } else {
    try {
      normalizeTrackingDestination(`${url.origin}/`);
    } catch {
      throw new TrackingServiceError("invalid_origin");
    }
  }
  return url.origin;
}

const TRACKER_VERIFICATION_PATH = "/.well-known/aurora-tracker-verification.txt";
const TRACKER_VERIFICATION_MAX_BYTES = 4 * 1024;
const TRACKER_VERIFICATION_TIMEOUT_MS = 4_000;

function createTrackerVerificationChallenge() {
  return `aurora-site-verification=${randomBytes(32).toString("base64url")}`;
}

function ipv4Bytes(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map(Number);
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? bytes : null;
}

function ipv6Bytes(value: string): number[] | null {
  const normalized = value.toLowerCase().split("%", 1)[0];
  const mappedIndex = normalized.lastIndexOf(":");
  let source = normalized;
  if (normalized.includes(".")) {
    const v4 = ipv4Bytes(normalized.slice(mappedIndex + 1));
    if (!v4) return null;
    source = `${normalized.slice(0, mappedIndex)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) return null;
  return words.flatMap((word) => {
    const parsed = Number.parseInt(word, 16);
    return [parsed >>> 8, parsed & 0xff];
  });
}

/** Fail closed for every non-global address, including DNS rebinding destinations. */
export function isPublicTrackerAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const bytes = ipv4Bytes(address);
    if (!bytes) return false;
    const [a, b, c] = bytes;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return false;
    const allZero = bytes.every((byte) => byte === 0);
    const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
    const uniqueLocal = (bytes[0] & 0xfe) === 0xfc;
    const linkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
    const multicast = bytes[0] === 0xff;
    const documentation = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
    const mappedV4 = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (mappedV4) return isPublicTrackerAddress(bytes.slice(12).join("."));
    const globalUnicast = (bytes[0] & 0xe0) === 0x20;
    return globalUnicast && !(allZero || loopback || uniqueLocal || linkLocal || multicast || documentation);
  }
  return false;
}

function localVerificationOrigins(): Set<string> {
  if (process.env.NODE_ENV === "production" && process.env.AURORA_TRACKER_ALLOW_LOCAL_VERIFICATION !== "true") {
    return new Set();
  }
  return new Set(
    String(process.env.AURORA_TRACKER_LOCAL_VERIFICATION_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        try {
          const url = new URL(value);
          const hostname = url.hostname.toLowerCase();
          const loopback = hostname === "localhost" || hostname === "127.0.0.1"
            || hostname === "::1" || hostname === "[::1]";
          return url.protocol === "http:" && loopback ? url.origin : "";
        } catch { return ""; }
      })
      .filter(Boolean),
  );
}

type ResolvedTrackerAddress = { address: string; family: 4 | 6 };
type TrackerResolver = (hostname: string) => Promise<ResolvedTrackerAddress[]>;

async function resolveTrackerHost(hostname: string): Promise<ResolvedTrackerAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records
    .filter((record): record is { address: string; family: 4 | 6 } => record.family === 4 || record.family === 6)
    .map((record) => ({ address: record.address, family: record.family }));
}

async function approvedTrackerAddresses(
  url: URL,
  resolve: TrackerResolver,
  allowedLocalOrigins: ReadonlySet<string>,
) {
  const addresses = await resolve(url.hostname);
  if (addresses.length === 0) throw new TrackingServiceError("verification_unavailable");
  const localAllowed = allowedLocalOrigins.has(url.origin);
  if (!localAllowed && (url.protocol !== "https:" || addresses.some((entry) => !isPublicTrackerAddress(entry.address)))) {
    throw new TrackingServiceError("verification_unavailable");
  }
  if (localAllowed && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TrackingServiceError("verification_unavailable");
  }
  return addresses;
}

function fetchPinnedTrackerFile(input: {
  url: URL;
  addresses: ResolvedTrackerAddress[];
  timeoutMs: number;
  maxBytes: number;
}): Promise<{ status: number; location: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    let addressIndex = 0;
    const transport = input.url.protocol === "https:" ? https : http;
    const request = transport.request(input.url, {
      method: "GET",
      headers: { accept: "text/plain", "user-agent": "Aurora-Tracker-Verification/1.0" },
      lookup: (_hostname, _options, callback) => {
        const selected = input.addresses[addressIndex % input.addresses.length];
        addressIndex += 1;
        callback(null, selected.address, selected.family);
      },
      signal: AbortSignal.timeout(input.timeoutMs),
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer | Uint8Array) => {
        const bytes = Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > input.maxBytes) {
          response.destroy(new TrackingServiceError("verification_unavailable"));
          return;
        }
        chunks.push(bytes);
      });
      response.on("end", () => {
        try {
          const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          resolve({ status: response.statusCode ?? 0, location: response.headers.location ?? null, body });
        } catch {
          reject(new TrackingServiceError("verification_unavailable"));
        }
      });
    });
    request.on("error", () => reject(new TrackingServiceError("verification_unavailable")));
    request.end();
  });
}

export async function verifyTrackerChallengeFile(input: {
  siteOrigin: string;
  challenge: string;
  resolve?: TrackerResolver;
  allowedLocalOrigins?: ReadonlySet<string>;
  fetchPinned?: typeof fetchPinnedTrackerFile;
}) {
  if (!/^aurora-site-verification=[A-Za-z0-9_-]{32,128}$/u.test(input.challenge)) {
    throw new TrackingServiceError("verification_unavailable");
  }
  const origin = normalizeTrackerOrigin(input.siteOrigin, true);
  const allowedLocalOrigins = input.allowedLocalOrigins ?? localVerificationOrigins();
  let url = new URL(TRACKER_VERIFICATION_PATH, origin);
  const resolve = input.resolve ?? resolveTrackerHost;
  const fetchPinned = input.fetchPinned ?? fetchPinnedTrackerFile;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const addresses = await approvedTrackerAddresses(url, resolve, allowedLocalOrigins);
    const response = await fetchPinned({
      url,
      addresses,
      timeoutMs: TRACKER_VERIFICATION_TIMEOUT_MS,
      maxBytes: TRACKER_VERIFICATION_MAX_BYTES,
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      const next = new URL(response.location, url);
      if (next.origin !== origin || next.pathname !== TRACKER_VERIFICATION_PATH || next.search || next.hash) {
        throw new TrackingServiceError("verification_unavailable");
      }
      url = next;
      continue;
    }
    if (response.status !== 200 || response.body !== input.challenge) {
      throw new TrackingServiceError("verification_unavailable");
    }
    return true;
  }
  throw new TrackingServiceError("verification_unavailable");
}

function normalizeWindow(value: unknown) {
  const days = Number(value ?? 30);
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
    throw new TrackingServiceError("invalid_window");
  }
  return days;
}

async function withTransaction<T>(pool: TransactionPool, task: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await task(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function templateView(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    name: String(row.name),
    values: (row.values ?? {}) as UtmValues,
    version: Number(row.version),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function linkView(row: Record<string, unknown>) {
  const expiresAt = row.expires_at == null ? null : new Date(String(row.expires_at)).toISOString();
  const storedStatus = String(row.status);
  const status = storedStatus === "active" && expiresAt && new Date(expiresAt).getTime() <= Date.now()
    ? "expired"
    : storedStatus;
  return {
    id: Number(row.id),
    slug: String(row.slug),
    destinationUrl: String(row.destination_url),
    utmValues: (row.utm_values ?? {}) as UtmValues,
    templateId: row.template_id == null ? null : Number(row.template_id),
    status,
    version: Number(row.version),
    expiresAt,
    createdAt: new Date(String(row.created_at)).toISOString(),
    totalClicks: row.total_clicks == null ? undefined : Number(row.total_clicks),
    uniqueClicks: row.unique_clicks == null ? undefined : Number(row.unique_clicks),
    conversions: row.conversions == null ? undefined : Number(row.conversions),
  };
}

export async function listProjectUtmTemplates(db: Queryable, actorUserId: number) {
  const membership = await requireSelectedProjectPermission(db, actorUserId, "project.read");
  const result = await db.query(
    `select id, name, values, version, updated_at
       from project_utm_templates
      where project_id = $1 and is_archived = false
      order by lower(name), id`,
    [membership.projectId],
  );
  return result.rows.map((row) => templateView(row as Record<string, unknown>));
}

export async function createProjectUtmTemplate(input: {
  pool: TransactionPool;
  actorUserId: number;
  name: unknown;
  values: unknown;
  requestId?: string | null;
}) {
  const name = normalizeName(input.name);
  const values = normalizeUtm(input.values);
  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "project.manage");
    const inserted = await client.query(
      `insert into project_utm_templates
         (project_id, name, values, created_by_user_id, updated_by_user_id)
       values ($1, $2, $3::jsonb, $4, $4)
       returning id, name, values, version, updated_at`,
      [membership.projectId, name, JSON.stringify(values), input.actorUserId],
    );
    const row = inserted.rows[0] as Record<string, unknown>;
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id, after_version, safe_data, request_id)
       values ($1, $2, 'tracking.template.created', 'utm_template', $3, 1, $4::jsonb, $5)`,
      [membership.projectId, input.actorUserId, String(row.id), JSON.stringify({ fields: Object.keys(values).sort() }), input.requestId ?? null],
    );
    return templateView(row);
  });
}

export async function updateProjectUtmTemplate(input: {
  pool: TransactionPool;
  actorUserId: number;
  templateId: number;
  expectedVersion: unknown;
  name: unknown;
  values: unknown;
  requestId?: string | null;
}) {
  const templateId = positiveId(input.templateId);
  const expectedVersion = positiveId(input.expectedVersion);
  if (!templateId) throw new TrackingServiceError("invalid_template");
  if (!expectedVersion) throw new TrackingServiceError("version_conflict");
  const name = normalizeName(input.name);
  const values = normalizeUtm(input.values);
  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "project.manage");
    const updated = await client.query(
      `update project_utm_templates
          set name = $4, values = $5::jsonb, version = version + 1,
              updated_by_user_id = $2, updated_at = now()
        where id = $3 and project_id = $1 and is_archived = false and version = $6
        returning id, name, values, version, updated_at`,
      [membership.projectId, input.actorUserId, templateId, name, JSON.stringify(values), expectedVersion],
    );
    if (!updated.rows[0]) {
      const exists = await client.query(
        `select version from project_utm_templates where id = $1 and project_id = $2 and is_archived = false`,
        [templateId, membership.projectId],
      );
      throw new TrackingServiceError(exists.rows[0] ? "version_conflict" : "not_found");
    }
    const row = updated.rows[0] as Record<string, unknown>;
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id, before_version, after_version, safe_data, request_id)
       values ($1, $2, 'tracking.template.updated', 'utm_template', $3, $4, $5, $6::jsonb, $7)`,
      [membership.projectId, input.actorUserId, String(templateId), expectedVersion, row.version, JSON.stringify({ fields: Object.keys(values).sort() }), input.requestId ?? null],
    );
    return templateView(row);
  });
}

export async function archiveProjectUtmTemplate(input: {
  pool: TransactionPool;
  actorUserId: number;
  templateId: number;
  expectedVersion: unknown;
  requestId?: string | null;
}) {
  const templateId = positiveId(input.templateId);
  const expectedVersion = positiveId(input.expectedVersion);
  if (!templateId) throw new TrackingServiceError("invalid_template");
  if (!expectedVersion) throw new TrackingServiceError("version_conflict");
  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "project.manage");
    const updated = await client.query(
      `update project_utm_templates
          set is_archived = true, version = version + 1,
              updated_by_user_id = $2, updated_at = now()
        where id = $3 and project_id = $1 and is_archived = false and version = $4
        returning version`,
      [membership.projectId, input.actorUserId, templateId, expectedVersion],
    );
    if (!updated.rows[0]) {
      const exists = await client.query(
        `select version from project_utm_templates where id = $1 and project_id = $2 and is_archived = false`,
        [templateId, membership.projectId],
      );
      throw new TrackingServiceError(exists.rows[0] ? "version_conflict" : "not_found");
    }
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id, before_version, after_version, request_id)
       values ($1, $2, 'tracking.template.archived', 'utm_template', $3, $4, $5, $6)`,
      [membership.projectId, input.actorUserId, String(templateId), expectedVersion, Number(updated.rows[0].version), input.requestId ?? null],
    );
    return { id: templateId, archived: true };
  });
}

export async function configureProjectTracking(input: {
  pool: TransactionPool;
  actorUserId: number;
  siteOrigin: unknown;
  attributionWindowDays: unknown;
  expectedVersion: unknown;
  requestId?: string | null;
}) {
  const siteOrigin = normalizeTrackerOrigin(input.siteOrigin);
  const attributionWindowDays = normalizeWindow(input.attributionWindowDays);
  const expectedVersion = Number(input.expectedVersion ?? 0);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new TrackingServiceError("version_conflict");
  }
  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "project.manage");
    const existing = await client.query(
      `select site_origin, public_key, status, version, verification_challenge
         from project_tracking_settings where project_id = $1 for update`,
      [membership.projectId],
    );
    const current = existing.rows[0] as Record<string, unknown> | undefined;
    if ((current ? Number(current.version) : 0) !== expectedVersion) {
      throw new TrackingServiceError("version_conflict");
    }
    const publicKey = current?.public_key && PUBLIC_KEY.test(String(current.public_key))
      ? String(current.public_key)
      : createShortLinkSlug();
    const preserveVerification = current?.site_origin === siteOrigin && current?.status === "active";
    const challenge = current?.site_origin === siteOrigin && typeof current?.verification_challenge === "string"
      ? current.verification_challenge
      : createTrackerVerificationChallenge();
    const saved = await client.query(
      `insert into project_tracking_settings
         (project_id, status, site_origin, public_key, attribution_window_days,
          version, updated_by_user_id, verified_at, last_ping_at, verification_challenge,
          signal_received_at, verification_checked_at, verification_error_code)
       values ($1, 'pending_verification', $2, $3, $4, 1, $5, null, null, $7, null, null, null)
       on conflict (project_id) do update
         set status = case when $6 then project_tracking_settings.status else 'pending_verification' end,
             site_origin = excluded.site_origin,
             public_key = excluded.public_key,
             attribution_window_days = excluded.attribution_window_days,
             version = project_tracking_settings.version + 1,
             updated_by_user_id = excluded.updated_by_user_id,
             verified_at = case when $6 then project_tracking_settings.verified_at else null end,
             last_ping_at = case when $6 then project_tracking_settings.last_ping_at else null end,
             verification_challenge = $7,
             signal_received_at = case when $6 then project_tracking_settings.signal_received_at else null end,
             verification_checked_at = case when $6 then project_tracking_settings.verification_checked_at else null end,
             verification_error_code = case when $6 then project_tracking_settings.verification_error_code else null end,
             updated_at = now()
       returning status, site_origin, public_key, attribution_window_days, version, verified_at, last_ping_at,
                 verification_challenge, signal_received_at, verification_checked_at, verification_error_code`,
      [membership.projectId, siteOrigin, publicKey, attributionWindowDays, input.actorUserId, preserveVerification, challenge],
    );
    const row = saved.rows[0] as Record<string, unknown>;
    await client.query(
      `insert into audit_events
       (project_id, actor_user_id, action, entity_type, entity_id, before_version, after_version, safe_data, request_id)
       values ($1::bigint, $2::bigint, 'tracking.settings.updated', 'tracking_settings',
               ($1::bigint)::text, $3::bigint, $4::bigint, $5::jsonb, $6)`,
      [membership.projectId, input.actorUserId, current ? Number(current.version) : null, row.version, JSON.stringify({ siteOrigin, attributionWindowDays }), input.requestId ?? null],
    );
    return trackingSettingsView(row);
  });
}

function trackingSettingsView(row?: Record<string, unknown>) {
  if (!row) {
    return {
      status: "not_connected",
      siteOrigin: null,
      publicKey: null,
      attributionWindowDays: 30,
      version: 0,
      verifiedAt: null,
      lastPingAt: null,
      signalReceivedAt: null,
      verificationCheckedAt: null,
      verificationErrorCode: null,
      verificationFilePath: TRACKER_VERIFICATION_PATH,
      verificationFileContent: null,
    };
  }
  return {
    status: String(row.status),
    siteOrigin: row.site_origin == null ? null : String(row.site_origin),
    publicKey: row.public_key == null ? null : String(row.public_key),
    attributionWindowDays: Number(row.attribution_window_days),
    version: Number(row.version),
    verifiedAt: row.verified_at == null ? null : new Date(String(row.verified_at)).toISOString(),
    lastPingAt: row.last_ping_at == null ? null : new Date(String(row.last_ping_at)).toISOString(),
    signalReceivedAt: row.signal_received_at == null ? null : new Date(String(row.signal_received_at)).toISOString(),
    verificationCheckedAt: row.verification_checked_at == null ? null : new Date(String(row.verification_checked_at)).toISOString(),
    verificationErrorCode: row.verification_error_code == null ? null : String(row.verification_error_code),
    verificationFilePath: TRACKER_VERIFICATION_PATH,
    verificationFileContent: row.verification_challenge == null ? null : String(row.verification_challenge),
  };
}

export async function getProjectTrackingSettings(db: Queryable, actorUserId: number) {
  const membership = await requireSelectedProjectPermission(db, actorUserId, "project.read");
  const result = await db.query(
    `select status, site_origin, public_key, attribution_window_days, version, verified_at, last_ping_at,
            verification_challenge, signal_received_at, verification_checked_at, verification_error_code
       from project_tracking_settings where project_id = $1`,
    [membership.projectId],
  );
  return trackingSettingsView(result.rows[0] as Record<string, unknown> | undefined);
}

export async function markTrackerPing(db: Queryable, input: {
  publicKey: unknown;
  requestOrigin: unknown;
  now?: Date;
}) {
  const publicKey = String(input.publicKey ?? "").trim();
  if (!PUBLIC_KEY.test(publicKey)) throw new TrackingServiceError("invalid_public_key");
  const requestOrigin = normalizeTrackerOrigin(input.requestOrigin);
  const now = input.now ?? new Date();
  const updated = await db.query(
    `update project_tracking_settings
        set last_ping_at = $3, signal_received_at = $3, updated_at = $3
      where public_key = $1 and site_origin = $2
      returning project_id, status, site_origin, public_key, attribution_window_days,
                version, verified_at, last_ping_at, verification_challenge,
                signal_received_at, verification_checked_at, verification_error_code`,
    [publicKey, requestOrigin, now],
  );
  if (!updated.rows[0]) throw new TrackingServiceError("not_found");
  return trackingSettingsView(updated.rows[0] as Record<string, unknown>);
}

export async function verifyProjectTrackingSite(input: {
  pool: TransactionPool & Queryable;
  actorUserId: number;
  expectedVersion: unknown;
  requestId?: string | null;
  verifyChallenge?: typeof verifyTrackerChallengeFile;
  now?: Date;
}) {
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
    throw new TrackingServiceError("version_conflict");
  }
  const membership = await requireSelectedProjectPermission(input.pool, input.actorUserId, "project.manage");
  const before = (await input.pool.query(
    `select status, site_origin, public_key, attribution_window_days, version, verified_at, last_ping_at,
            verification_challenge, signal_received_at, verification_checked_at, verification_error_code
       from project_tracking_settings
      where project_id = $1`,
    [membership.projectId],
  )).rows[0] as Record<string, unknown> | undefined;
  if (!before) throw new TrackingServiceError("tracker_not_connected");
  if (Number(before.version) !== expectedVersion) throw new TrackingServiceError("version_conflict");
  const siteOrigin = String(before.site_origin ?? "");
  const challenge = String(before.verification_challenge ?? "");
  if (!siteOrigin || !challenge) throw new TrackingServiceError("tracker_not_connected");

  let verified = false;
  let safeErrorCode: string | null = null;
  try {
    await (input.verifyChallenge ?? verifyTrackerChallengeFile)({ siteOrigin, challenge });
    verified = true;
  } catch {
    safeErrorCode = "challenge_unavailable_or_mismatch";
  }
  const now = input.now ?? new Date();
  return withTransaction(input.pool, async (client) => {
    const currentMembership = await requireSelectedProjectPermission(client, input.actorUserId, "project.manage");
    if (currentMembership.projectId !== membership.projectId) throw new ProjectAccessError("membership_required");
    const current = (await client.query(
      `select version, site_origin, verification_challenge
         from project_tracking_settings
        where project_id = $1
        for update`,
      [membership.projectId],
    )).rows[0] as Record<string, unknown> | undefined;
    if (
      !current
      || Number(current.version) !== expectedVersion
      || current.site_origin !== siteOrigin
      || current.verification_challenge !== challenge
    ) throw new TrackingServiceError("version_conflict");
    const updated = await client.query(
      `update project_tracking_settings
          set status = $2::text,
              verified_at = case when $3::boolean then $4::timestamptz else null end,
              verification_checked_at = $4::timestamptz,
              verification_error_code = $5,
              version = version + 1,
              updated_by_user_id = $6::bigint,
              updated_at = $4::timestamptz
        where project_id = $1::bigint and version = $7::bigint
        returning status, site_origin, public_key, attribution_window_days, version, verified_at, last_ping_at,
                  verification_challenge, signal_received_at, verification_checked_at, verification_error_code`,
      [
        membership.projectId,
        verified ? "active" : "verification_failed",
        verified,
        now,
        safeErrorCode,
        input.actorUserId,
        expectedVersion,
      ],
    );
    if (!updated.rows[0]) throw new TrackingServiceError("version_conflict");
    const row = updated.rows[0] as Record<string, unknown>;
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id,
          before_version, after_version, safe_data, request_id)
       values ($1::bigint, $2::bigint, $3, 'tracking_settings', ($1::bigint)::text,
               $4::bigint, $5::bigint, $6::jsonb, $7)`,
      [
        membership.projectId,
        input.actorUserId,
        verified ? "tracking.site.verified" : "tracking.site.verification_failed",
        expectedVersion,
        Number(row.version),
        JSON.stringify({ status: row.status, errorCode: safeErrorCode }),
        input.requestId ?? null,
      ],
    );
    return { verified, tracking: trackingSettingsView(row) };
  });
}

export async function verifyTrackerCorsOrigin(db: Queryable, input: {
  publicKey: unknown;
  requestOrigin: unknown;
  requireActive?: boolean;
}) {
  const publicKey = String(input.publicKey ?? "").trim();
  if (!PUBLIC_KEY.test(publicKey)) throw new TrackingServiceError("invalid_public_key");
  const requestOrigin = normalizeTrackerOrigin(input.requestOrigin);
  const result = await db.query(
    `select status from project_tracking_settings
      where public_key = $1 and site_origin = $2
        and ($3::boolean = false or status = 'active')
      limit 1`,
    [publicKey, requestOrigin, input.requireActive !== false],
  );
  if (!result.rows[0]) throw new TrackingServiceError("not_found");
  return requestOrigin;
}

export async function createProjectShortLink(input: {
  pool: TransactionPool;
  actorUserId: number;
  destination: unknown;
  utmValues: unknown;
  templateId?: unknown;
  expiresAt?: unknown;
  idempotencyKey: unknown;
  requestId?: string | null;
  now?: Date;
}) {
  const destination = normalizeDestination(input.destination);
  const directValues = normalizeUtm(input.utmValues);
  const templateId = input.templateId == null ? null : positiveId(input.templateId);
  if (input.templateId != null && !templateId) throw new TrackingServiceError("invalid_template");
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? new Date();
  const expiresAt = normalizeExpiry(input.expiresAt, now);
  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "content.create");
    let templateValues: UtmValues = {};
    if (templateId) {
      const template = await client.query(
        `select values from project_utm_templates
          where id = $1 and project_id = $2 and is_archived = false`,
        [templateId, membership.projectId],
      );
      if (!template.rows[0]) throw new TrackingServiceError("invalid_template");
      templateValues = normalizeUtm(template.rows[0].values);
    }
    const utmValues = normalizeUtmValues({ ...templateValues, ...directValues });
    const trackedDestination = buildTrackedDestination(destination, utmValues);
    const requestHash = hashCanonical({ trackedDestination, utmValues, templateId, expiresAt: expiresAt?.toISOString() ?? null });
    const replay = await client.query(
      `with lock_scope as materialized (
         select pg_advisory_xact_lock(hashtextextended($4, 0))
       )
       select link.id, link.slug, link.destination_url, link.utm_values,
              link.template_id, link.status, link.version, link.expires_at,
              link.created_at, link.request_hash
         from short_links link
         cross join lock_scope
        where link.project_id = $1 and link.created_by_user_id = $2
          and link.request_key = $3`,
      [membership.projectId, input.actorUserId, idempotencyKey,
        `tracking:link:${membership.projectId}:${input.actorUserId}:${idempotencyKey}`],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== requestHash) {
        throw new TrackingServiceError("idempotency_conflict");
      }
      return linkView(replay.rows[0] as Record<string, unknown>);
    }
    const slug = createShortLinkSlug();
    const destinationHash = createHash("sha256").update(trackedDestination, "utf8").digest("hex");
    const inserted = await client.query(
      `insert into short_links
         (project_id, created_by_user_id, request_key, request_hash, template_id,
          slug, destination_url, destination_hash, utm_values, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       returning id, slug, destination_url, utm_values, template_id, status, version, expires_at, created_at`,
      [membership.projectId, input.actorUserId, idempotencyKey, requestHash, templateId, slug, trackedDestination, destinationHash, JSON.stringify(utmValues), expiresAt],
    );
    const row = inserted.rows[0] as Record<string, unknown>;
    const hostname = new URL(trackedDestination).hostname;
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id, after_version, safe_data, request_id, idempotency_key)
       values ($1, $2, 'tracking.link.created', 'short_link', $3, 1, $4::jsonb, $5, $6)`,
      [membership.projectId, input.actorUserId, String(row.id), JSON.stringify({ hostname, fields: Object.keys(utmValues).sort() }), input.requestId ?? null, `tracking:link:${idempotencyKey}`],
    );
    return linkView(row);
  });
}

export async function listProjectShortLinks(db: Queryable, actorUserId: number, limit = 100) {
  const membership = await requireSelectedProjectPermission(db, actorUserId, "project.read");
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 250);
  const result = await db.query(
    `select link.id, link.slug, link.destination_url, link.utm_values, link.template_id,
            link.status, link.version, link.expires_at, link.created_at,
            count(distinct click.id) filter (where click.is_likely_bot = false) as total_clicks,
            count(distinct click.id) filter (where click.is_likely_bot = false and click.is_unique = true) as unique_clicks,
            count(distinct conversion.id) as conversions
       from short_links link
       left join short_link_clicks click on click.short_link_id = link.id and click.project_id = link.project_id
       left join conversion_events conversion on conversion.short_link_id = link.id and conversion.project_id = link.project_id
      where link.project_id = $1
      group by link.id
      order by link.created_at desc, link.id desc
      limit $2`,
    [membership.projectId, safeLimit],
  );
  return result.rows.map((row) => linkView(row as Record<string, unknown>));
}

export async function revokeProjectShortLink(input: {
  pool: TransactionPool;
  actorUserId: number;
  linkId: number;
  expectedVersion: unknown;
  requestId?: string | null;
}) {
  const linkId = positiveId(input.linkId);
  const expectedVersion = positiveId(input.expectedVersion);
  if (!linkId) throw new TrackingServiceError("not_found");
  if (!expectedVersion) throw new TrackingServiceError("version_conflict");
  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "content.edit");
    const updated = await client.query(
      `update short_links
          set status = 'revoked', revoked_at = now(), version = version + 1, updated_at = now()
        where id = $1 and project_id = $2 and status = 'active' and version = $3
        returning id, version`,
      [linkId, membership.projectId, expectedVersion],
    );
    if (!updated.rows[0]) {
      const exists = await client.query(
        `select version from short_links where id = $1 and project_id = $2`,
        [linkId, membership.projectId],
      );
      throw new TrackingServiceError(exists.rows[0] ? "version_conflict" : "not_found");
    }
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id, before_version, after_version, request_id)
       values ($1, $2, 'tracking.link.revoked', 'short_link', $3, $4, $5, $6)`,
      [membership.projectId, input.actorUserId, String(linkId), expectedVersion, Number(updated.rows[0].version), input.requestId ?? null],
    );
    return { id: linkId, status: "revoked", version: Number(updated.rows[0].version) };
  });
}

export type RedirectTarget = {
  linkId: number;
  placementId: number | null;
  projectId: number;
  destinationUrl: string;
  attributionWindowDays: number;
};

export async function getRedirectTarget(db: Queryable, slugInput: unknown, now = new Date()): Promise<RedirectTarget> {
  const slug = String(slugInput ?? "").trim();
  if (!PUBLIC_KEY.test(slug)) throw new TrackingServiceError("not_found");
  const result = await db.query(
    `select candidate.id, candidate.placement_id, candidate.project_id,
            candidate.destination_url, candidate.status, candidate.expires_at,
            coalesce(settings.attribution_window_days, 30) as attribution_window_days
       from (
         select link.id, placement.id as placement_id, link.project_id,
                link.destination_url, link.status, link.expires_at, 0 as priority
           from short_link_placements placement
           join short_links link
             on link.id = placement.short_link_id and link.project_id = placement.project_id
          where placement.slug = $1
         union all
         select link.id, null::bigint as placement_id, link.project_id,
                link.destination_url, link.status, link.expires_at, 1 as priority
           from short_links link
          where link.slug = $1
       ) candidate
      left join project_tracking_settings settings on settings.project_id = candidate.project_id
      order by candidate.priority
      limit 2`,
    [slug],
  );
  // Slugs are random and collisions are practically impossible, but a redirect is
  // still fail-closed if a base-link slug and a placement slug ever overlap.
  if (result.rows.length !== 1) throw new TrackingServiceError("not_found");
  const row = result.rows[0] as Record<string, unknown>;
  if (row.status !== "active" || (row.expires_at && new Date(String(row.expires_at)).getTime() <= now.getTime())) {
    throw new TrackingServiceError("link_unavailable");
  }
  return {
    linkId: Number(row.id),
    placementId: row.placement_id == null ? null : Number(row.placement_id),
    projectId: Number(row.project_id),
    destinationUrl: normalizeDestination(row.destination_url),
    attributionWindowDays: normalizeWindow(row.attribution_window_days),
  };
}

function clientClass(userAgent: string | null | undefined) {
  const value = (userAgent ?? "").toLowerCase();
  if (!value) return "unknown";
  if (/(telegrambot|vkshare|preview|facebookexternalhit)/u.test(value)) return "preview";
  if (/(bot|crawler|spider|headless|curl|wget)/u.test(value)) return "crawler";
  return "browser";
}

function referrerHost(value: string | null | undefined) {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase().slice(0, 253) || null;
  } catch {
    return null;
  }
}

export async function recordTrackedClick(input: {
  pool: TransactionPool;
  target: RedirectTarget;
  ip: string | null;
  userAgent: string | null;
  referrer: string | null;
  fingerprintSecret: string;
  attributionSecret: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const windowKey = now.toISOString().slice(0, 10);
  const visitorHash = visitorFingerprint(
    { ip: input.ip, userAgent: input.userAgent },
    input.fingerprintSecret,
    `project:${input.target.projectId}:link:${input.target.linkId}:placement:${input.target.placementId ?? "base"}`,
  );
  const dedupeKey = clickDedupeKey({
    shortLinkId: input.target.linkId,
    placementId: input.target.placementId,
    visitorHash,
    windowKey,
  }, input.fingerprintSecret);
  const clickId = randomUUID();
  const likelyBot = classifyLikelyBot(input.userAgent);
  const attributionExpiresAt = new Date(now.getTime() + input.target.attributionWindowDays * 24 * 60 * 60 * 1_000);
  const isUnique = await withTransaction(input.pool, async (client) => {
    const unique = await client.query(
      `insert into short_link_unique_visitors
         (project_id, short_link_id, dedupe_key, first_seen_at, last_seen_at)
       values ($1, $2, $3, $4, $4)
       on conflict (short_link_id, dedupe_key) do nothing
       returning dedupe_key`,
      [input.target.projectId, input.target.linkId, dedupeKey, now],
    );
    if (!unique.rows[0]) {
      await client.query(
        `update short_link_unique_visitors set last_seen_at = $4
          where project_id = $1 and short_link_id = $2 and dedupe_key = $3`,
        [input.target.projectId, input.target.linkId, dedupeKey, now],
      );
    }
    await client.query(
      `insert into short_link_clicks
         (id, project_id, short_link_id, placement_id, visitor_hash, dedupe_key, is_unique,
          is_likely_bot, client_class, referrer_host, occurred_at, attribution_expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [clickId, input.target.projectId, input.target.linkId, input.target.placementId,
        visitorHash, dedupeKey, Boolean(unique.rows[0]), likelyBot, clientClass(input.userAgent),
        referrerHost(input.referrer), now, attributionExpiresAt],
    );
    return Boolean(unique.rows[0]);
  });
  const token = likelyBot ? null : signAttribution(
    { shortLinkId: input.target.linkId, clickId },
    input.attributionSecret,
    { now: Math.floor(now.getTime() / 1_000), ttlSeconds: input.target.attributionWindowDays * 24 * 60 * 60 },
  );
  return { clickId, isUnique, likelyBot, token, attributionExpiresAt };
}

function normalizeEventType(value: unknown): ConversionEventType {
  if (!EVENT_TYPES.includes(value as ConversionEventType)) throw new TrackingServiceError("invalid_event");
  return value as ConversionEventType;
}

export async function recordConversionEvent(input: {
  pool: TransactionPool;
  publicKey: unknown;
  token: unknown;
  idempotencyKey: unknown;
  eventType: unknown;
  requestOrigin: unknown;
  attributionSecret: string;
  occurredAt?: unknown;
  now?: Date;
}) {
  const publicKey = String(input.publicKey ?? "").trim();
  if (!PUBLIC_KEY.test(publicKey)) throw new TrackingServiceError("invalid_public_key");
  const token = String(input.token ?? "").trim();
  const eventType = normalizeEventType(input.eventType);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const requestOrigin = normalizeTrackerOrigin(input.requestOrigin);
  const now = input.now ?? new Date();
  const payload = verifyAttribution(token, input.attributionSecret, { now: Math.floor(now.getTime() / 1_000) });
  if (!payload) throw new TrackingServiceError("invalid_attribution");
  const occurredAt = input.occurredAt == null ? now : new Date(String(input.occurredAt));
  if (
    Number.isNaN(occurredAt.getTime())
    || occurredAt.getTime() > now.getTime() + 5 * 60_000
    || occurredAt.getTime() < payload.issuedAt * 1_000 - 5 * 60_000
    || occurredAt.getTime() > payload.expiresAt * 1_000
  ) throw new TrackingServiceError("invalid_event");
  return withTransaction(input.pool, async (client) => {
    const attribution = await client.query(
      `select click.project_id, click.short_link_id, click.is_likely_bot,
              settings.status as tracker_status, settings.site_origin, settings.public_key
         from short_link_clicks click
         join short_links link
           on link.id = click.short_link_id and link.project_id = click.project_id
         left join project_tracking_settings settings on settings.project_id = click.project_id
        where click.id = $1 and click.short_link_id = $2
        for update of click`,
      [payload.clickId, payload.shortLinkId],
    );
    const row = attribution.rows[0] as Record<string, unknown> | undefined;
    if (!row || row.is_likely_bot === true) throw new TrackingServiceError("invalid_attribution");
    if (row.tracker_status !== "active" || row.site_origin !== requestOrigin || row.public_key !== publicKey) {
      throw new TrackingServiceError("tracker_not_connected");
    }
    const projectId = Number(row.project_id);
    const idempotencyHash = conversionIdempotencyHash(projectId, idempotencyKey);
    const requestHash = hashCanonical({ eventType, clickId: payload.clickId, occurredAt: occurredAt.toISOString() });
    const replay = await client.query(
      `select id, event_type, occurred_at, received_at, request_hash
         from conversion_events where project_id = $1 and idempotency_hash = $2`,
      [projectId, idempotencyHash],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== requestHash) {
        throw new TrackingServiceError("idempotency_conflict");
      }
      return {
        id: String(replay.rows[0].id),
        eventType: String(replay.rows[0].event_type),
        occurredAt: new Date(String(replay.rows[0].occurred_at)).toISOString(),
        duplicate: true,
      };
    }
    const tokenHash = createHmac("sha256", input.attributionSecret).update(token).digest("hex");
    const inserted = await client.query(
      `insert into conversion_events
         (project_id, short_link_id, click_id, event_type, idempotency_hash,
          request_hash, attribution_token_hash, occurred_at, safe_properties)
       values ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)
       returning id, event_type, occurred_at`,
      [projectId, payload.shortLinkId, payload.clickId, eventType, idempotencyHash, requestHash, tokenHash, occurredAt],
    );
    return {
      id: String(inserted.rows[0].id),
      eventType: String(inserted.rows[0].event_type),
      occurredAt: new Date(String(inserted.rows[0].occurred_at)).toISOString(),
      duplicate: false,
    };
  });
}

export async function getProjectTrackingReport(db: Queryable, input: {
  actorUserId: number;
  from?: Date;
  to?: Date;
}) {
  const membership = await requireSelectedProjectPermission(db, input.actorUserId, "project.read");
  const to = input.to ?? new Date();
  const from = input.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new TrackingServiceError("invalid_event");
  }
  const [settings, rows] = await Promise.all([
    db.query(
      `select status, site_origin, public_key, attribution_window_days, version, verified_at, last_ping_at
         from project_tracking_settings where project_id = $1`,
      [membership.projectId],
    ),
    db.query(
      `with scopes as (
         -- The base scope keeps clicks from links copied outside a publication. It has
         -- no post attribution, so legacy shared-link clicks can never be duplicated.
         select link.id as link_id, link.project_id, null::bigint as placement_id
           from short_links link
          where link.project_id = $1
         union all
         select placement.short_link_id, placement.project_id, placement.id
           from short_link_placements placement
          where placement.project_id = $1
       ), click_metrics as (
         select click.short_link_id, click.project_id, click.placement_id,
                count(*) filter (where click.is_likely_bot = false) as total_clicks,
                count(*) filter (where click.is_likely_bot = false and click.is_unique = true) as unique_clicks
           from short_link_clicks click
          where click.project_id = $1 and click.occurred_at >= $2 and click.occurred_at < $3
          group by click.short_link_id, click.project_id, click.placement_id
       ), conversion_metrics as (
         select conversion.short_link_id, conversion.project_id, click.placement_id,
                count(*) as confirmed_conversions,
                count(*) filter (where conversion.event_type = 'form_open') as form_opens,
                count(*) filter (where conversion.event_type = 'form_submit') as form_submits,
                count(*) filter (where conversion.event_type = 'consultation_booked') as consultations
           from conversion_events conversion
           join short_link_clicks click
             on click.id = conversion.click_id
            and click.short_link_id = conversion.short_link_id
            and click.project_id = conversion.project_id
          where conversion.project_id = $1
            and conversion.occurred_at >= $2 and conversion.occurred_at < $3
          group by conversion.short_link_id, conversion.project_id, click.placement_id
       )
       select link.id as link_id, coalesce(placement.slug, link.slug) as slug, link.utm_values,
              tracking.post_id, post.channel_id, channel.title as channel_title,
              coalesce(clicks.total_clicks, 0) as total_clicks,
              coalesce(clicks.unique_clicks, 0) as unique_clicks,
              coalesce(conversions.confirmed_conversions, 0) as confirmed_conversions,
              coalesce(conversions.form_opens, 0) as form_opens,
              coalesce(conversions.form_submits, 0) as form_submits,
              coalesce(conversions.consultations, 0) as consultations
         from scopes scope
         join short_links link
           on link.id = scope.link_id and link.project_id = scope.project_id
         left join short_link_placements placement
           on placement.id = scope.placement_id
          and placement.short_link_id = scope.link_id
          and placement.project_id = scope.project_id
         left join publication_tracking_snapshots tracking
           on tracking.short_link_placement_id = scope.placement_id
          and tracking.short_link_id = scope.link_id
          and tracking.project_id = scope.project_id
         left join posts post on post.id = tracking.post_id and post.project_id = tracking.project_id
         left join channels channel on channel.id = post.channel_id and channel.project_id = post.project_id
         left join click_metrics clicks
           on clicks.short_link_id = scope.link_id and clicks.project_id = scope.project_id
          and clicks.placement_id is not distinct from scope.placement_id
         left join conversion_metrics conversions
           on conversions.short_link_id = scope.link_id and conversions.project_id = scope.project_id
          and conversions.placement_id is not distinct from scope.placement_id
        where scope.placement_id is not null
           or coalesce(clicks.total_clicks, 0) > 0
           or coalesce(conversions.confirmed_conversions, 0) > 0
           or not exists (
             select 1
               from short_link_placements placement
              where placement.short_link_id = scope.link_id
                and placement.project_id = scope.project_id
           )
        order by link.created_at desc, link.id desc, scope.placement_id nulls first`,
      [membership.projectId, from, to],
    ),
  ]);
  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    tracker: trackingSettingsView(settings.rows[0] as Record<string, unknown> | undefined),
    methodology: {
      totalClicks: "Переходы без очевидных ботов; каждый запрос считается отдельно.",
      uniqueClicks: "Первый переход одного обезличенного браузера по адресу конкретной публикации за календарные сутки UTC.",
      conversions: "Только события с действующей подписанной атрибуцией и уникальным ключом события.",
      postAttribution: "Каждая публикация получает отдельный непрозрачный адрес. Переходы по общей ссылке учитываются без привязки к посту.",
    },
    rows: rows.rows.map((row) => ({
      linkId: Number(row.link_id),
      slug: String(row.slug),
      campaign: row.utm_values?.utm_campaign ?? null,
      source: row.utm_values?.utm_source ?? null,
      medium: row.utm_values?.utm_medium ?? null,
      postId: row.post_id == null ? null : Number(row.post_id),
      channelId: row.channel_id == null ? null : Number(row.channel_id),
      channelTitle: row.channel_title == null ? null : String(row.channel_title),
      totalClicks: Number(row.total_clicks ?? 0),
      uniqueClicks: Number(row.unique_clicks ?? 0),
      confirmedConversions: Number(row.confirmed_conversions ?? 0),
      formOpens: Number(row.form_opens ?? 0),
      formSubmits: Number(row.form_submits ?? 0),
      consultations: Number(row.consultations ?? 0),
    })),
  };
}
