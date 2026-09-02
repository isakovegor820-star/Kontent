import { randomUUID } from "node:crypto";

import { validateAuroraProductEventDraft } from "./product-event-contract.mjs";
import { insertProductEvent, observeRelease } from "./product-event-store.mjs";
import { auroraReleaseMetadata } from "./release-metadata.mjs";

const SAFE_ERROR_CODE = /^[a-z0-9_]{1,100}$/u;
const MAX_DURATION_MS = 3_600_000;

/**
 * Accepts only values that already are machine codes (`vk_token_expired`); messages,
 * URLs and provider payloads are not rewritten into codes but collapse to the fallback,
 * so free text never reaches product_events.
 *
 * @param {unknown} value
 * @param {string} fallback
 */
export function safeProductErrorCode(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[.:-]/gu, "_");
  return SAFE_ERROR_CODE.test(normalized) ? normalized : fallback;
}

/** Bounded, non-negative integer milliseconds or null. */
export function productDurationMs(startedAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(startedAtMs)) return null;
  const elapsed = Math.round(nowMs - startedAtMs);
  return elapsed >= 0 && elapsed <= MAX_DURATION_MS ? elapsed : null;
}

/**
 * Records an event whose tenant is only known through a channel (generation operations
 * are channel-anchored). Resolves the project server-side and then delegates.
 *
 * @param {{ connect: Function; query: Function }} pool
 * @param {Omit<Parameters<typeof recordServerProductEvent>[1], "projectId"> & { channelId: number }} input
 * @param {Parameters<typeof recordServerProductEvent>[2]} [options]
 */
export async function recordChannelProductEvent(pool, input, options = {}) {
  const logger = options.logger ?? console;
  let projectId;
  try {
    const channel = await pool.query(
      "select project_id from channels where id = $1 and user_id = $2",
      [input.channelId, input.userId],
    );
    projectId = Number(channel.rows[0]?.project_id);
  } catch (error) {
    logger.error("[product-events-server]", {
      code: "product_event_channel_lookup_failed",
      errorName: error instanceof Error ? error.name : "Error",
      sectionId: input.sectionId,
      action: input.action,
    });
    return false;
  }
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return false;
  const { channelId, ...rest } = input;
  void channelId;
  return recordServerProductEvent(pool, { ...rest, projectId }, options);
}

/**
 * Records one server-confirmed product event. Best-effort by design: the domain
 * operation has already succeeded or failed, so telemetry must never change its
 * outcome. Validation, tenant identity and the release marker are all server-owned.
 *
 * @param {{ connect: () => Promise<{ query: Function; release: () => void }> }} pool
 * @param {{
 *   userId: number;
 *   projectId: number;
 *   sectionId: string;
 *   featureId: string;
 *   action: string;
 *   stage: string;
 *   outcome: string;
 *   source: "api" | "worker" | "bot" | "system";
 *   operationKind: string;
 *   durationMs?: number | null;
 *   errorCode?: string | null;
 *   requestId?: string | null;
 *   operationId?: string | null;
 *   queue?: string | null;
 *   attempt?: number | null;
 *   resultKind?: string | null;
 *   occurredAt?: string;
 * }} input
 * @param {{ release?: { release: string | null; commitSha: string | null; deployedAt: string | null }; nowMs?: number; logger?: Pick<Console, "error"> }} [options]
 * @returns {Promise<boolean>} true when the event was stored
 */
export async function recordServerProductEvent(pool, input, options = {}) {
  const logger = options.logger ?? console;
  const nowMs = options.nowMs ?? Date.now();
  const requestId = typeof input.requestId === "string" && input.requestId ? input.requestId : randomUUID();
  const safeContext = {
    device: "unknown",
    source: input.source,
    operationKind: input.operationKind,
    ...(input.queue ? { queue: input.queue } : {}),
    ...(Number.isSafeInteger(input.attempt) && input.attempt >= 0 ? { attempt: input.attempt } : {}),
    ...(input.resultKind ? { resultKind: input.resultKind } : {}),
  };
  const validated = validateAuroraProductEventDraft({
    eventId: randomUUID(),
    sectionId: input.sectionId,
    featureId: input.featureId,
    action: input.action,
    stage: input.stage,
    outcome: input.outcome,
    durationMs: input.durationMs ?? null,
    errorCode: input.errorCode ?? null,
    requestId,
    operationId: input.operationId ?? null,
    sessionId: null,
    occurredAt: input.occurredAt ?? new Date(nowMs).toISOString(),
    safeContext,
  }, { nowMs });
  if (!validated.ok) {
    logger.error("[product-events-server]", {
      code: validated.error,
      field: validated.field ?? null,
      sectionId: input.sectionId,
      action: input.action,
    });
    return false;
  }
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || !Number.isSafeInteger(input.projectId) || input.projectId <= 0) {
    logger.error("[product-events-server]", { code: "product_event_tenant_invalid", sectionId: input.sectionId, action: input.action });
    return false;
  }

  const release = options.release ?? auroraReleaseMetadata();
  let client;
  try {
    client = await pool.connect();
    await client.query("begin");
    await observeRelease(client, release);
    const stored = await insertProductEvent(client, {
      event: validated.event,
      actorUserId: input.userId,
      projectId: input.projectId,
      fallbackRequestId: requestId,
      release,
    });
    await client.query("commit");
    return stored;
  } catch (error) {
    if (client) await client.query("rollback").catch(() => undefined);
    logger.error("[product-events-server]", {
      code: "product_event_store_unavailable",
      errorName: error instanceof Error ? error.name : "Error",
      sectionId: input.sectionId,
      action: input.action,
    });
    return false;
  } finally {
    client?.release();
  }
}
