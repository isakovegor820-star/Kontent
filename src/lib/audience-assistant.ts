import type { Pool, PoolClient } from "pg";

import {
  AUDIENCE_DELIVERY_ERROR_CODES,
  AUDIENCE_DELIVERY_LEASE_SECONDS,
  AUDIENCE_FAIL_DELIVERY_SQL,
  AUDIENCE_FINISH_DELIVERY_SQL,
  AUDIENCE_STALE_DELIVERY_CAS_SQL,
  AUDIENCE_STALE_PROJECT_DELIVERIES_SQL,
  audienceDeliveryLeaseExpired,
  classifyAudienceTelegramResponse,
} from "./audience-delivery-contract.mjs";
import { getPool } from "./db";
import { emitOperationalSignal, OPERATIONAL_SIGNAL_EVENTS } from "./operational-signal.mjs";
import {
  ProjectAccessError,
  requireSelectedProjectPermission,
  roleAllows,
} from "./project-permissions";

export const AUDIENCE_INQUIRY_SOURCES = [
  "telegram_business",
  "comment",
  "direct_message",
  "support",
  "review",
  "other",
] as const;

export const AUDIENCE_INQUIRY_STATUSES = [
  "pending",
  "reply_ready",
  "approved",
  "sent",
  "dismissed",
  "failed",
] as const;

export const AUDIENCE_REPLY_TONES = ["positive", "neutral", "negative", "aggressive"] as const;
export const AUDIENCE_REPLY_RISKS = ["low", "medium", "high"] as const;
export { AUDIENCE_DELIVERY_LEASE_SECONDS, audienceDeliveryLeaseExpired } from "./audience-delivery-contract.mjs";

export type AudienceInquirySource = (typeof AUDIENCE_INQUIRY_SOURCES)[number];
export type AudienceInquiryStatus = (typeof AUDIENCE_INQUIRY_STATUSES)[number];
export type AudienceReplyTone = (typeof AUDIENCE_REPLY_TONES)[number];
export type AudienceReplyRisk = (typeof AUDIENCE_REPLY_RISKS)[number];

export type AudienceInquiryRecord = {
  id: number;
  projectId: number;
  sourceType: AudienceInquirySource;
  sourceLabel: string | null;
  sourceUrl: string | null;
  authorName: string | null;
  incomingText: string;
  context: string | null;
  suggestedReply: string | null;
  replyGuidance: string | null;
  tone: AudienceReplyTone | null;
  riskLevel: AudienceReplyRisk | null;
  status: AudienceInquiryStatus;
  canSendViaTelegram: boolean;
  canDeliverReply: boolean;
  deliveryErrorCode: string | null;
  version: number;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AudienceAssistantStats = {
  waiting: number;
  ready: number;
  answered: number;
  dismissed: number;
  highRisk: number;
};

export type AudienceAssistantCapabilities = {
  canCreate: boolean;
  canEdit: boolean;
  canSend: boolean;
};

export type GeneratedAudienceReply = {
  reply: string;
  guidance: string;
  tone: AudienceReplyTone;
  riskLevel: AudienceReplyRisk;
};

export class AudienceAssistantError extends Error {
  constructor(public readonly code:
    | "invalid_request"
    | "not_found"
    | "version_conflict"
    | "invalid_status"
    | "not_sendable"
    | "delivery_in_progress"
    | "delivery_unknown"
    | "telegram_not_configured"
    | "telegram_rejected") {
    super(code);
    this.name = "AudienceAssistantError";
  }
}

type Queryable = Pick<Pool | PoolClient, "query">;
type TransactionPool = Pick<Pool, "connect">;
type InquiryRow = Record<string, unknown>;

const INQUIRY_SELECT = `
  select inquiry.id, inquiry.project_id, inquiry.source_type, inquiry.source_label,
         inquiry.source_url, inquiry.author_name, inquiry.incoming_text, inquiry.context,
         inquiry.suggested_reply, inquiry.reply_guidance, inquiry.tone, inquiry.risk_level,
         inquiry.status, inquiry.business_connection_id, inquiry.external_chat_id,
         inquiry.external_message_id, inquiry.delivery_request_key,
         inquiry.provider_started_at, inquiry.sent_external_message_id,
         inquiry.delivery_error_code, inquiry.version,
         inquiry.resolved_at, inquiry.created_at, inquiry.updated_at
    from bot_client_inquiries inquiry`;

function cleanText(value: unknown, max: number, required = false): string | null {
  if (value == null || value === "") {
    if (required) throw new AudienceAssistantError("invalid_request");
    return null;
  }
  if (typeof value !== "string") throw new AudienceAssistantError("invalid_request");
  const clean = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .trim();
  if ((required && clean.length < 1) || clean.length > max) {
    throw new AudienceAssistantError("invalid_request");
  }
  return clean || null;
}

function positiveInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AudienceAssistantError("invalid_request");
  }
  return parsed;
}

function safeKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/u.test(value)) {
    throw new AudienceAssistantError("invalid_request");
  }
  return value;
}

function safeSource(value: unknown): AudienceInquirySource {
  if (!AUDIENCE_INQUIRY_SOURCES.includes(value as AudienceInquirySource) || value === "telegram_business") {
    throw new AudienceAssistantError("invalid_request");
  }
  return value as AudienceInquirySource;
}

function safeStatus(value: unknown): AudienceInquiryStatus {
  if (!AUDIENCE_INQUIRY_STATUSES.includes(value as AudienceInquiryStatus)) {
    throw new AudienceAssistantError("invalid_request");
  }
  return value as AudienceInquiryStatus;
}

function safeUrl(value: unknown): string | null {
  const clean = cleanText(value, 2_048);
  if (!clean) return null;
  try {
    const url = new URL(clean);
    if (url.protocol !== "https:") throw new Error("protocol");
    return url.toString();
  } catch {
    throw new AudienceAssistantError("invalid_request");
  }
}

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value);
}

async function recoverStaleAudienceDeliveries(db: Queryable, projectId: number) {
  const recovered = await db.query(
    AUDIENCE_STALE_PROJECT_DELIVERIES_SQL,
    [projectId, AUDIENCE_DELIVERY_LEASE_SECONDS],
  );
  if (recovered.rowCount) {
    emitOperationalSignal({
      event: OPERATIONAL_SIGNAL_EVENTS.deliveryUnknown,
      surface: "web_recovery",
      projectId,
      count: recovered.rowCount,
    });
  }
}

function mapInquiry(row: InquiryRow, canDeliverReply = false): AudienceInquiryRecord {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    sourceType: String(row.source_type || "telegram_business") as AudienceInquirySource,
    sourceLabel: row.source_label == null ? null : String(row.source_label),
    sourceUrl: row.source_url == null ? null : String(row.source_url),
    authorName: row.author_name == null ? null : String(row.author_name),
    incomingText: String(row.incoming_text),
    context: row.context == null ? null : String(row.context),
    suggestedReply: row.suggested_reply == null ? null : String(row.suggested_reply),
    replyGuidance: row.reply_guidance == null ? null : String(row.reply_guidance),
    tone: row.tone == null ? null : String(row.tone) as AudienceReplyTone,
    riskLevel: row.risk_level == null ? null : String(row.risk_level) as AudienceReplyRisk,
    status: String(row.status) as AudienceInquiryStatus,
    canSendViaTelegram: row.external_chat_id != null && row.external_message_id != null
      && (row.business_connection_id != null || row.source_type === "comment"),
    canDeliverReply,
    deliveryErrorCode: row.delivery_error_code == null ? null : String(row.delivery_error_code),
    version: Number(row.version),
    resolvedAt: nullableIso(row.resolved_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function selectInquiry(
  db: Queryable,
  projectId: number,
  inquiryId: number,
  suffix = "",
  canDeliverReply = false,
): Promise<AudienceInquiryRecord | null> {
  const row = (await db.query<InquiryRow>(
    `${INQUIRY_SELECT} where inquiry.project_id = $1 and inquiry.id = $2 ${suffix}`,
    [projectId, inquiryId],
  )).rows[0];
  return row ? mapInquiry(row, canDeliverReply) : null;
}

export async function listAudienceInquiries(input: {
  actorUserId: number;
  db?: Queryable;
}): Promise<{
  inquiries: AudienceInquiryRecord[];
  stats: AudienceAssistantStats;
  capabilities: AudienceAssistantCapabilities;
}> {
  const db = input.db ?? getPool();
  const membership = await requireSelectedProjectPermission(db, input.actorUserId, "project.read");
  const canDeliverReply = roleAllows(membership.role, "audience.reply.send");
  await recoverStaleAudienceDeliveries(db, membership.projectId);
  const [rows, statsResult] = await Promise.all([
    db.query<InquiryRow>(
      `${INQUIRY_SELECT}
        where inquiry.project_id = $1
        order by
          case inquiry.status
            when 'pending' then 1 when 'failed' then 2 when 'reply_ready' then 3
            when 'approved' then 4 when 'sent' then 5 else 6
          end,
          case inquiry.risk_level when 'high' then 1 when 'medium' then 2 else 3 end,
          inquiry.created_at desc, inquiry.id desc
        limit 500`,
      [membership.projectId],
    ),
    db.query<{
      waiting: number | string;
      ready: number | string;
      answered: number | string;
      dismissed: number | string;
      high_risk: number | string;
    }>(
      `select
         count(*) filter (where status in ('pending','failed')) as waiting,
         count(*) filter (where status in ('reply_ready','approved')) as ready,
         count(*) filter (where status = 'sent') as answered,
         count(*) filter (where status = 'dismissed') as dismissed,
         count(*) filter (where risk_level = 'high' and status in ('pending','failed','reply_ready','approved')) as high_risk
       from bot_client_inquiries where project_id = $1`,
      [membership.projectId],
    ),
  ]);
  const stats = statsResult.rows[0];
  return {
    inquiries: rows.rows.map((row) => mapInquiry(row, canDeliverReply)),
    stats: {
      waiting: Number(stats?.waiting ?? 0),
      ready: Number(stats?.ready ?? 0),
      answered: Number(stats?.answered ?? 0),
      dismissed: Number(stats?.dismissed ?? 0),
      highRisk: Number(stats?.high_risk ?? 0),
    },
    capabilities: {
      canCreate: roleAllows(membership.role, "content.create"),
      canEdit: roleAllows(membership.role, "content.edit"),
      canSend: canDeliverReply,
    },
  };
}

export async function getAudienceInquiry(input: {
  actorUserId: number;
  inquiryId: number;
  permission?: "project.read" | "content.edit";
  db?: Queryable;
}): Promise<AudienceInquiryRecord> {
  const db = input.db ?? getPool();
  const membership = await requireSelectedProjectPermission(db, input.actorUserId, input.permission ?? "project.read");
  const inquiry = await selectInquiry(
    db,
    membership.projectId,
    positiveInteger(input.inquiryId),
    "",
    roleAllows(membership.role, "audience.reply.send"),
  );
  if (!inquiry) throw new AudienceAssistantError("not_found");
  return inquiry;
}

export async function createAudienceInquiry(input: {
  actorUserId: number;
  requestKey: unknown;
  sourceType: unknown;
  sourceLabel?: unknown;
  sourceUrl?: unknown;
  authorName?: unknown;
  incomingText: unknown;
  context?: unknown;
  pool?: TransactionPool;
}): Promise<{ inquiry: AudienceInquiryRecord; duplicate: boolean }> {
  const requestKey = safeKey(input.requestKey);
  const sourceType = safeSource(input.sourceType);
  const sourceLabel = cleanText(input.sourceLabel, 200);
  const sourceUrl = safeUrl(input.sourceUrl);
  const authorName = cleanText(input.authorName, 200);
  const incomingText = cleanText(input.incomingText, 8_000, true) as string;
  const context = cleanText(input.context, 4_000);
  const pool = input.pool ?? getPool();
  const db = await pool.connect();
  try {
    await db.query("begin");
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.create");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `audience-inquiry:${membership.projectId}:${requestKey}`,
    ]);
    const replay = (await db.query<InquiryRow>(
      `${INQUIRY_SELECT} where inquiry.project_id = $1 and inquiry.request_key = $2 limit 1`,
      [membership.projectId, requestKey],
    )).rows[0];
    if (replay) {
      await db.query("commit");
      return {
        inquiry: mapInquiry(replay, roleAllows(membership.role, "audience.reply.send")),
        duplicate: true,
      };
    }
    const inserted = (await db.query<{ id: number | string }>(
      `insert into bot_client_inquiries (
         project_id, request_key, source_type, source_label, source_url,
         author_name, incoming_text, context, created_by_user_id
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning id`,
      [membership.projectId, requestKey, sourceType, sourceLabel, sourceUrl,
        authorName, incomingText, context, input.actorUserId],
    )).rows[0];
    const inquiry = await selectInquiry(
      db,
      membership.projectId,
      Number(inserted.id),
      "",
      roleAllows(membership.role, "audience.reply.send"),
    );
    if (!inquiry) throw new AudienceAssistantError("not_found");
    await db.query("commit");
    return { inquiry, duplicate: false };
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

export async function updateAudienceInquiry(input: {
  actorUserId: number;
  inquiryId: number;
  expectedVersion: unknown;
  status?: unknown;
  suggestedReply?: unknown;
  pool?: TransactionPool;
}): Promise<AudienceInquiryRecord> {
  const inquiryId = positiveInteger(input.inquiryId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const pool = input.pool ?? getPool();
  const db = await pool.connect();
  try {
    await db.query("begin");
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "project.read");
    const canDeliverReply = roleAllows(membership.role, "audience.reply.send");
    const current = await selectInquiry(db, membership.projectId, inquiryId, "for update of inquiry", canDeliverReply);
    if (!current) throw new AudienceAssistantError("not_found");
    if (current.version !== expectedVersion) throw new AudienceAssistantError("version_conflict");

    const requestedStatus = input.status == null ? null : safeStatus(input.status);
    const resolvesUnknownDelivery = current.deliveryErrorCode === "delivery_unknown"
      && input.suggestedReply === undefined
      && (requestedStatus === "sent" || requestedStatus === "pending");
    const requiredPermission = resolvesUnknownDelivery ? "audience.reply.send" : "content.edit";
    if (!roleAllows(membership.role, requiredPermission)) {
      throw new ProjectAccessError("permission_denied");
    }
    if (current.deliveryErrorCode === "delivery_unknown" && !resolvesUnknownDelivery) {
      throw new AudienceAssistantError("delivery_unknown");
    }
    if (requestedStatus && !["pending", "sent", "dismissed"].includes(requestedStatus)) {
      throw new AudienceAssistantError("invalid_status");
    }
    const reply = input.suggestedReply === undefined
      ? current.suggestedReply
      : cleanText(input.suggestedReply, 8_000, true);
    let nextStatus = requestedStatus ?? current.status;
    if (input.suggestedReply !== undefined && !requestedStatus) nextStatus = "reply_ready";
    if (nextStatus === "sent" && !reply) throw new AudienceAssistantError("invalid_status");
    if (nextStatus === "pending") {
      await db.query(
        `update bot_client_inquiries
            set status = 'pending', resolved_by_user_id = null, resolved_at = null,
                delivery_request_key = null, provider_started_at = null,
                sent_external_message_id = null, delivery_error_code = null,
                version = version + 1, updated_at = now()
          where id = $1 and project_id = $2 and version = $3`,
        [inquiryId, membership.projectId, expectedVersion],
      );
    } else {
      await db.query(
        `update bot_client_inquiries
            set suggested_reply = $4, status = $5,
                delivery_error_code = case when $5 = 'sent' then null else delivery_error_code end,
                resolved_by_user_id = case when $5 in ('sent','dismissed') then $6 else resolved_by_user_id end,
                resolved_at = case when $5 in ('sent','dismissed') then now() else null end,
                version = version + 1, updated_at = now()
          where id = $1 and project_id = $2 and version = $3`,
        [inquiryId, membership.projectId, expectedVersion, reply, nextStatus, input.actorUserId],
      );
    }
    const updated = await selectInquiry(db, membership.projectId, inquiryId, "", canDeliverReply);
    if (!updated) throw new AudienceAssistantError("not_found");
    if (resolvesUnknownDelivery) {
      await db.query(
        `insert into audit_events (
           project_id, actor_user_id, action, entity_type, entity_id,
           after_version, safe_data, idempotency_key
         ) values ($1,$2,'audience.reply.delivery_resolved','bot_client_inquiry',$3::text,$4,
                   jsonb_build_object('resolution', $5::text, 'surface', 'web'), $6)
         on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
        [membership.projectId, input.actorUserId, inquiryId, updated.version,
          nextStatus === "sent" ? "sent" : "retry",
          `audit:audience-resolved:${inquiryId}:v${updated.version}`.slice(0, 180)],
      );
    }
    await db.query("commit");
    return updated;
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

export async function saveGeneratedAudienceReply(input: {
  actorUserId: number;
  inquiryId: number;
  expectedVersion: number;
  generated: GeneratedAudienceReply;
  pool?: TransactionPool;
}): Promise<AudienceInquiryRecord> {
  const pool = input.pool ?? getPool();
  const db = await pool.connect();
  try {
    await db.query("begin");
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.edit");
    const canDeliverReply = roleAllows(membership.role, "audience.reply.send");
    const result = await db.query(
      `update bot_client_inquiries
          set suggested_reply = $4, reply_guidance = $5, tone = $6, risk_level = $7,
              status = 'reply_ready', resolved_by_user_id = null, resolved_at = null,
              version = version + 1, updated_at = now()
        where id = $1 and project_id = $2 and version = $3
          and status in ('pending','reply_ready','failed')`,
      [input.inquiryId, membership.projectId, input.expectedVersion,
        cleanText(input.generated.reply, 8_000, true),
        cleanText(input.generated.guidance, 2_000, true),
        input.generated.tone, input.generated.riskLevel],
    );
    if (!result.rowCount) {
      const exists = await selectInquiry(db, membership.projectId, input.inquiryId, "", canDeliverReply);
      throw new AudienceAssistantError(exists ? "version_conflict" : "not_found");
    }
    const updated = await selectInquiry(db, membership.projectId, input.inquiryId, "", canDeliverReply);
    if (!updated) throw new AudienceAssistantError("not_found");
    await db.query("commit");
    return updated;
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

type TelegramResponse = {
  ok?: boolean;
  result?: { message_id?: unknown };
  error_code?: unknown;
};

export type AudienceTelegramRequest = (
  method: "sendMessage",
  body: Record<string, unknown>,
) => Promise<TelegramResponse>;

type DeliveryPool = Pick<Pool, "connect" | "query">;

async function telegramBotRequest(
  method: "sendMessage",
  body: Record<string, unknown>,
): Promise<TelegramResponse> {
  const token = String(process.env.TG_BOT_TOKEN || "").trim();
  if (!token) throw new AudienceAssistantError("telegram_not_configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  return await response.json() as TelegramResponse;
}

async function finishAudienceDelivery(input: {
  pool: DeliveryPool;
  inquiryId: number;
  projectId: number;
  actorUserId: number;
  requestKey: string;
  externalMessageId: number;
}): Promise<AudienceInquiryRecord> {
  const db = await input.pool.connect();
  try {
    await db.query("begin");
    const result = await db.query(
      AUDIENCE_FINISH_DELIVERY_SQL,
      [input.inquiryId, input.projectId, input.requestKey, input.externalMessageId,
        input.actorUserId, "web"],
    );
    if (!result.rowCount) throw new AudienceAssistantError("version_conflict");
    const updated = await selectInquiry(db, input.projectId, input.inquiryId, "", true);
    if (!updated) throw new AudienceAssistantError("not_found");
    await db.query("commit");
    return updated;
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

async function failAudienceDelivery(input: {
  pool: DeliveryPool;
  inquiryId: number;
  projectId: number;
  actorUserId: number;
  requestKey: string;
  code: "delivery_unknown" | "telegram_rejected";
}) {
  const failed = await input.pool.query(
    AUDIENCE_FAIL_DELIVERY_SQL,
    [input.inquiryId, input.projectId, input.requestKey, input.code, input.actorUserId, "web"],
  );
  if (failed.rowCount) {
    emitOperationalSignal({
      event: input.code === AUDIENCE_DELIVERY_ERROR_CODES.rejected
        ? OPERATIONAL_SIGNAL_EVENTS.telegramRejected
        : OPERATIONAL_SIGNAL_EVENTS.deliveryUnknown,
      surface: "web",
      projectId: input.projectId,
      entityId: input.inquiryId,
    });
  }
}

export async function deliverAudienceReply(input: {
  actorUserId: number;
  inquiryId: number;
  expectedVersion: unknown;
  requestKey: unknown;
  reply: unknown;
  pool?: DeliveryPool;
  telegramRequest?: AudienceTelegramRequest;
}): Promise<{ inquiry: AudienceInquiryRecord; replayed: boolean }> {
  const inquiryId = positiveInteger(input.inquiryId);
  const expectedVersion = positiveInteger(input.expectedVersion);
  const requestKey = safeKey(input.requestKey);
  const reply = cleanText(input.reply, 4_096, true) as string;
  const pool = input.pool ?? getPool();
  if (!input.telegramRequest && !String(process.env.TG_BOT_TOKEN || "").trim()) {
    throw new AudienceAssistantError("telegram_not_configured");
  }
  const telegramRequest = input.telegramRequest ?? telegramBotRequest;
  const db = await pool.connect();
  let claimed: InquiryRow | null = null;
  let transactionOpen = false;
  try {
    await db.query("begin");
    transactionOpen = true;
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "audience.reply.send");
    const current = (await db.query<InquiryRow>(
      `${INQUIRY_SELECT}
        where inquiry.project_id = $1 and inquiry.id = $2
        for update of inquiry`,
      [membership.projectId, inquiryId],
    )).rows[0];
    if (!current) throw new AudienceAssistantError("not_found");
    if (current.delivery_request_key === requestKey && current.status === "sent") {
      await db.query("commit");
      return { inquiry: mapInquiry(current, true), replayed: true };
    }
    if (current.delivery_error_code === "delivery_unknown") {
      throw new AudienceAssistantError("delivery_unknown");
    }
    if (current.status === "approved") {
      if (audienceDeliveryLeaseExpired(current.provider_started_at)) {
        await db.query(
          AUDIENCE_STALE_DELIVERY_CAS_SQL,
          [inquiryId, membership.projectId, Number(current.version)],
        );
        await db.query("commit");
        transactionOpen = false;
        throw new AudienceAssistantError("delivery_unknown");
      }
      throw new AudienceAssistantError("delivery_in_progress");
    }
    if (Number(current.version) !== expectedVersion) {
      throw new AudienceAssistantError("version_conflict");
    }
    if (!roleAllows(membership.role, "content.edit")) {
      const currentReply = cleanText(current.suggested_reply, 8_000, true);
      if (currentReply !== reply) throw new ProjectAccessError("permission_denied");
    }
    const sendable = current.external_chat_id != null && current.external_message_id != null
      && (current.business_connection_id != null || current.source_type === "comment");
    if (!sendable) throw new AudienceAssistantError("not_sendable");
    if (!["pending", "reply_ready", "failed"].includes(String(current.status))) {
      throw new AudienceAssistantError("invalid_status");
    }
    const update = await db.query<InquiryRow>(
      `update bot_client_inquiries
          set suggested_reply = $4, status = 'approved', delivery_request_key = $5,
              provider_started_at = now(), sent_external_message_id = null,
              delivery_error_code = null, resolved_by_user_id = null, resolved_at = null,
              version = version + 1, updated_at = now()
        where id = $1 and project_id = $2 and version = $3
        returning *`,
      [inquiryId, membership.projectId, expectedVersion, reply, requestKey],
    );
    claimed = update.rows[0] ?? null;
    if (!claimed) throw new AudienceAssistantError("version_conflict");
    await db.query("commit");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }

  if (!claimed) throw new AudienceAssistantError("version_conflict");

  const projectId = Number(claimed.project_id);
  const body: Record<string, unknown> = {
    chat_id: Number(claimed.external_chat_id),
    text: reply,
  };
  if (claimed.business_connection_id != null) {
    body.business_connection_id = String(claimed.business_connection_id);
  } else {
    body.reply_parameters = {
      message_id: Number(claimed.external_message_id),
      allow_sending_without_reply: false,
    };
  }

  let response: TelegramResponse;
  try {
    response = await telegramRequest("sendMessage", body);
  } catch (error) {
    await failAudienceDelivery({
      pool,
      inquiryId,
      projectId,
      actorUserId: input.actorUserId,
      requestKey,
      code: AUDIENCE_DELIVERY_ERROR_CODES.unknown,
    });
    if (error instanceof AudienceAssistantError && error.code === "telegram_not_configured") throw error;
    throw new AudienceAssistantError("delivery_unknown");
  }
  const outcome = classifyAudienceTelegramResponse(response);
  if (outcome.kind !== "delivered") {
    const code = outcome.kind === "rejected"
      ? AUDIENCE_DELIVERY_ERROR_CODES.rejected
      : AUDIENCE_DELIVERY_ERROR_CODES.unknown;
    await failAudienceDelivery({
      pool,
      inquiryId,
      projectId,
      actorUserId: input.actorUserId,
      requestKey,
      code,
    });
    if (outcome.kind === "unknown") throw new AudienceAssistantError("delivery_unknown");
    throw new AudienceAssistantError("telegram_rejected");
  }
  return {
    inquiry: await finishAudienceDelivery({
      pool,
      inquiryId,
      projectId,
      actorUserId: input.actorUserId,
      requestKey,
      externalMessageId: outcome.externalMessageId,
    }),
    replayed: false,
  };
}
