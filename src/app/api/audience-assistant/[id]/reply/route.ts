import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getAudienceInquiry, saveGeneratedAudienceReply } from "@/lib/audience-assistant";
import { parseGeneratedAudienceReply } from "@/lib/audience-reply-output";
import {
  aiReady,
  resolveEngineRuntime,
  serializeUntrustedPromptData,
  type GenerateParams,
} from "@/lib/ai-provider";
import { configuredFallbackEngines, orchestrateText, publicAiFailureCode } from "@/lib/ai-orchestrator";
import {
  acquireAiUsageRequest,
  aiRequestFingerprint,
  commitAiUsageResult,
  releaseAiUsageRequest,
} from "@/lib/ai-usage";
import { getPool } from "@/lib/db";
import { DEFAULT_ENGINE, getEngine, isEngineId } from "@/lib/engines";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  audienceAssistantApiError,
  audienceAssistantBody,
  audienceAssistantBodyFailure,
  audienceAssistantJson,
  audienceAssistantRouteId,
} from "../../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) {
    return audienceAssistantJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  }
  const user = await getSessionUser(request);
  if (!user) return audienceAssistantJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const inquiryId = audienceAssistantRouteId((await params).id);
  if (!inquiryId) return audienceAssistantJson({ ok: false, error: "bad_inquiry" }, 400, requestId);
  const rate = await checkRateLimit(`audience-assistant:reply:user:${user.id}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await audienceAssistantBody(request, ["expectedVersion"]);
  if (!parsed.ok) return audienceAssistantBodyFailure(parsed.error, requestId);
  const expectedVersion = Number(parsed.body.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
    return audienceAssistantJson({ ok: false, error: "bad_request" }, 400, requestId);
  }

  let reservationId: number | null = null;
  let operationId = requestId;
  try {
    const inquiry = await getAudienceInquiry({
      actorUserId: user.id,
      inquiryId,
      permission: "content.edit",
    });
    if (inquiry.version !== expectedVersion) {
      return audienceAssistantJson({ ok: false, error: "version_conflict" }, 409, requestId);
    }
    if (!["pending", "reply_ready", "failed"].includes(inquiry.status)) {
      return audienceAssistantJson({ ok: false, error: "invalid_status" }, 409, requestId);
    }

    const pool = getPool();
    const [userSettings, briefRows] = await Promise.all([
      pool.query<{ ai_engine: string | null }>("select ai_engine from users where id = $1", [user.id]),
      pool.query(
        `select niche, audience, goal, cta, taboo, profile_answers
           from content_brief
          where project_id = $1 and ready = true
          order by updated_at desc limit 3`,
        [inquiry.projectId],
      ),
    ]);
    const chosen = isEngineId(userSettings.rows[0]?.ai_engine)
      ? userSettings.rows[0].ai_engine
      : DEFAULT_ENGINE;
    const runtime = resolveEngineRuntime(chosen);
    const fallbacks = configuredFallbackEngines(chosen);
    if ((!runtime.supported || !runtime.configured) && fallbacks.length === 0) {
      const engine = getEngine(chosen);
      return audienceAssistantJson({
        ok: false,
        error: runtime.supported ? "engine_not_connected" : "engine_unsupported",
        engine: engine.id,
        label: `${engine.label} (${engine.vendor})`,
      }, 503, requestId);
    }
    if (fallbacks.length === 0 && !await aiReady(chosen)) {
      return audienceAssistantJson({ ok: false, error: "engine_offline" }, 503, requestId);
    }

    const requestFingerprint = aiRequestFingerprint({
      scope: "audience-reply-v1",
      inquiryId,
      expectedVersion,
      incomingText: inquiry.incomingText,
      context: inquiry.context,
      projectContext: briefRows.rows,
      engine: chosen,
    });
    const usageKey = `audience-reply:${inquiryId}:${expectedVersion}`;
    operationId = randomUUID();
    const reservation = await acquireAiUsageRequest(user.id, "audience-reply", {
      reservationKey: usageKey,
      fingerprint: requestFingerprint,
      operationId,
    });
    reservationId = reservation.reservationId;
    if (
      (reservation.requestState === "replay" || reservation.requestState === "terminal_pending_ack")
      && reservation.result
    ) {
      const generated = parseGeneratedAudienceReply(reservation.result.text);
      if (!generated) {
        return audienceAssistantJson({ ok: false, error: "request_result_unavailable" }, 409, requestId);
      }
      const current = await getAudienceInquiry({ actorUserId: user.id, inquiryId, permission: "content.edit" });
      if (current.version !== expectedVersion && current.suggestedReply) {
        return audienceAssistantJson({ ok: true, inquiry: current, replayed: true }, 200, requestId);
      }
      const saved = await saveGeneratedAudienceReply({
        actorUserId: user.id,
        inquiryId,
        expectedVersion,
        generated,
      });
      return audienceAssistantJson({ ok: true, inquiry: saved, replayed: true }, 200, requestId);
    }
    if (reservation.requestState === "in_progress") {
      return audienceAssistantJson({ ok: false, error: "request_in_progress" }, 409, requestId);
    }
    if (reservation.requestState === "conflict") {
      return audienceAssistantJson({ ok: false, error: "idempotency_key_conflict" }, 409, requestId);
    }
    if (!reservation.allowed) {
      return audienceAssistantJson({ ok: false, error: "limit", used: reservation.used, limit: reservation.limit }, 429, requestId);
    }

    const task = [
      "Проанализируй входящее сообщение и подготовь ответ по контракту.",
      `Источник: ${serializeUntrustedPromptData(inquiry.sourceLabel || inquiry.sourceType, 200)}`,
      `Автор: ${serializeUntrustedPromptData(inquiry.authorName || "не указан", 200)}`,
      `Входящее сообщение: ${serializeUntrustedPromptData(inquiry.incomingText, 8_000)}`,
      `Контекст обращения: ${serializeUntrustedPromptData(inquiry.context || "не указан", 4_000)}`,
      `Подтверждённый контекст проекта: ${serializeUntrustedPromptData(JSON.stringify(briefRows.rows), 8_000)}`,
    ].join("\n");
    const params: GenerateParams = {
      kind: "reply",
      task,
      providerRequestId: requestId,
      providerRequestKey: aiRequestFingerprint({ requestFingerprint, chosen, model: runtime.model }),
    };
    let raw = "";
    let resultEngine = chosen;
    let fallbackUsed = false;
    for await (const event of orchestrateText(params, chosen, {
      signal: request.signal,
      fallbackEngines: fallbacks,
      firstTokenMs: 12_000,
      overallMs: 60_000,
    })) {
      if (event.type === "delta") {
        raw += event.text;
        resultEngine = event.engine;
      } else if (event.type === "fallback") {
        fallbackUsed = true;
      }
    }
    const generated = parseGeneratedAudienceReply(raw);
    if (!generated) throw new Error("invalid_reply_contract");
    const saved = await saveGeneratedAudienceReply({
      actorUserId: user.id,
      inquiryId,
      expectedVersion,
      generated,
    });
    const committed = await commitAiUsageResult(user.id, reservationId, operationId, {
      protocol: "text",
      text: JSON.stringify(generated),
      pipeline: "single",
      requestedEngine: chosen,
      engine: resultEngine,
      fallbackUsed,
    });
    if (!committed.changed && committed.status !== "committed") {
      throw new Error("usage_commit_failed");
    }
    return audienceAssistantJson({ ok: true, inquiry: saved }, 200, requestId);
  } catch (error) {
    if (reservationId != null) {
      await releaseAiUsageRequest(user.id, reservationId, operationId).catch(() => undefined);
    }
    if (error instanceof Error && error.name === "AbortError") {
      return audienceAssistantJson({ ok: false, error: "cancelled" }, 499, requestId);
    }
    if (error instanceof Error && error.message === "invalid_reply_contract") {
      return audienceAssistantJson({ ok: false, error: "invalid_ai_response" }, 502, requestId);
    }
    const code = publicAiFailureCode(error);
    if (code !== "provider_error" || error instanceof TypeError) {
      return audienceAssistantJson({ ok: false, error: code }, 503, requestId);
    }
    return audienceAssistantApiError(error, requestId);
  }
}
