// Генерация контента ИИ (ТЗ Д.8). Стримит ответ по мере генерации. Перед генерацией:
// проверяем дневной лимит, подкладываем прошлые посты пользователя как образец стиля.
// Движок скрыт за переходником ai-provider — этот роут не знает, Ollama там или облако.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import {
  AiProviderError,
  aiReady,
  resolveEngineRuntime,
  type AiKind,
  type AiRole,
  type ConversationTurn,
  type GenerateParams,
} from "@/lib/ai-provider";
import {
  configuredFallbackEngines,
  isTransientAiFailure,
  orchestrateText,
  publicAiFailureCode,
  type AiOrchestrationEvent,
  type AiPublicFailureCode,
} from "@/lib/ai-orchestrator";
import {
  AI_DAILY_LIMIT,
  acquireAiUsageRequest,
  aiRequestFingerprint,
  channelAiContextFor,
  lookupAiUsageRequest,
  releaseAiUsageRequest,
  stageAiUsageResult,
  styleSamplesFor,
  type AiUsageStoredResult,
} from "@/lib/ai-usage";
import { DEFAULT_ENGINE, ENGINES, getEngine, isEngineId, type EngineId } from "@/lib/engines";
import { AI_STREAM_CONTENT_TYPE, encodeAiStreamEvent, type AiStreamEvent } from "@/lib/ai-stream";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import {
  buildFactLedger,
  buildFactualRepairInstructions,
  preflightFactLedger,
  type FactLedger,
  type FactualValidationProvenance,
  type FactualValidationResult,
} from "@/lib/fact-ledger";
import {
  validateFactualOutputWithSemantics,
  type SemanticEntailmentAdapter,
} from "@/lib/semantic-entailment";
import { createConfiguredSemanticAdapter } from "@/lib/ai-semantic-adapter.mjs";
import { generationDeadlines } from "@/lib/ai-generation-deadlines";
import {
  buildPostRepairInstructions,
  normalizePostSettings,
  validatePostSettingsConflicts,
  validatePostSettingsResult,
} from "@/lib/post-settings";
import { validatePostQuality } from "@/lib/post-quality.mjs";
import { getDraftForUser } from "@/lib/server-drafts";
import {
  buildReferenceAdaptationTask,
  buildTopicRepairInstructions,
  referenceAdaptationContextFromDraft,
  validateTopicAlignment,
  type ReferenceAdaptationContext,
  type TopicAlignmentResult,
} from "@/lib/reference-adaptation";

export const runtime = "nodejs";

const KINDS: AiKind[] = ["write", "rewrite", "shorten", "plan", "script", "image", "poll", "longread"];
const ROLES: AiRole[] = ["copywriter", "strategist", "critic"];
const EDITORIAL_KINDS: AiKind[] = ["write", "rewrite", "shorten", "script", "poll", "longread"];
const VALIDATED_POST_KINDS: AiKind[] = ["write", "rewrite", "shorten", "script", "poll", "longread"];
const CHANNEL_QUALITY_KINDS: AiKind[] = ["write", "rewrite", "longread"];

class PostSettingsValidationError extends Error {
  constructor(
    public readonly issues: string[],
    public readonly errorCode: "post_validation_failed" | "factual_validation_failed" | "topic_alignment_failed" = "post_validation_failed",
  ) {
    super("post settings validation failed");
    this.name = "PostSettingsValidationError";
  }
}

class AiUsageFinalizationError extends Error {
  constructor() {
    super("ai usage reservation could not be committed");
    this.name = "AiUsageFinalizationError";
  }
}

type SafeLogLevel = "error" | "warn" | "info";
type SafeAiLogCode =
  | AiPublicFailureCode
  | "session_unavailable"
  | "settings_unavailable"
  | "context_unavailable"
  | "usage_finalization_unavailable"
  | "post_validation_failed"
  | "factual_validation_failed"
  | "topic_alignment_failed"
  | "usage_release_failed"
  | "forbidden_origin"
  | "request_replayed"
  | "usage_lookup_unavailable"
  | "usage_acquire_unavailable";

function logAiRequest(
  level: SafeLogLevel,
  requestId: string,
  code: SafeAiLogCode,
  details: { engine?: string; status?: number | null; scope?: string } = {},
) {
  const entry = {
    requestId,
    code,
    ...(details.engine ? { engine: details.engine.slice(0, 80) } : {}),
    ...(details.status !== undefined ? { status: details.status } : {}),
    ...(details.scope ? { scope: details.scope.slice(0, 40) } : {}),
  };
  console[level]("[/api/ai/generate]", entry);
}

function aiJson(
  requestId: string,
  payload: Record<string, unknown>,
  init: { status: number; headers?: HeadersInit },
) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-ai-request-id", requestId);
  return NextResponse.json({ ...payload, requestId }, { status: init.status, headers });
}

function prerequisiteUnavailable(
  requestId: string,
  error: unknown,
  scope: "session" | "settings" | "context",
) {
  void error;
  logAiRequest("error", requestId, `${scope}_unavailable`, { scope });
  return aiJson(
    requestId,
    {
      error: `${scope}_unavailable`,
      retryable: true,
      retryAfterSeconds: 30,
    },
    {
      status: 503,
      headers: {
        "retry-after": "30",
      },
    },
  );
}

function cleanHistory(value: unknown): ConversationTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): ConversationTurn | null => {
      if (!item || typeof item !== "object") return null;
      const raw = item as { role?: unknown; content?: unknown };
      if (raw.role !== "user" && raw.role !== "assistant") return null;
      const content = String(raw.content ?? "").trim().slice(0, 1800);
      return content ? { role: raw.role, content } : null;
    })
    .filter((item): item is ConversationTurn => item !== null)
    .slice(-8);
}

function failurePayload(
  requestId: string,
  error: unknown,
  engineId: ReturnType<typeof getEngine>["id"],
) {
  const effectiveEngine = error instanceof AiProviderError ? error.engineId : engineId;
  const engine = getEngine(effectiveEngine);
  if (error instanceof AiUsageFinalizationError) {
    logAiRequest("error", requestId, "usage_finalization_unavailable", { engine: engine.id });
    return {
      error: "usage_finalization_unavailable",
      engine: engine.id,
      label: `${engine.label} (${engine.vendor})`,
      retryable: true,
      code: "usage_finalization_unavailable",
      status: 503,
    };
  }
  if (error instanceof PostSettingsValidationError) {
    logAiRequest("warn", requestId, error.errorCode, { engine: engine.id, status: 422 });
    return {
      error: error.errorCode,
      engine: engine.id,
      label: `${engine.label} (${engine.vendor})`,
      retryable: false,
      code: error.errorCode,
      status: 422,
    };
  }
  let reason = "provider_unavailable";
  let status: number | null = null;
  let providerMessage: string | null = null;
  if (error instanceof AiProviderError) {
    status = error.status;
    providerMessage = error.providerMessage;
    reason = error.code === "first_token_timeout" || error.code === "overall_timeout" || error.code === "provider_timeout"
      ? "provider_timeout"
      : error.code === "stream_truncated"
        ? "stream_truncated"
      : error.code === "rate_limited"
      || error.code === "quota_exceeded"
      || error.status === 429
      ? "provider_rate_limited"
      : error.code === "reasoning_without_content" || error.code === "empty_generation"
        ? "empty_generation"
        : error.code === "network_error"
          ? "provider_network_error"
          : error.status === 400
            ? "provider_bad_request"
            : error.status === 401
              ? "provider_authentication_failed"
              : error.status === 403
                ? "provider_access_denied"
                : error.status === 409
                  ? "provider_conflict"
                  : error.status === 422
                    ? "provider_rejected"
                    : "provider_unavailable";
  } else if ((error as Error)?.name === "TimeoutError") {
    reason = "provider_timeout";
  } else if (error instanceof TypeError) {
    reason = "provider_network_error";
  }
  // Provider messages can reflect prompts or credentials and are never logged.
  void providerMessage;
  logAiRequest("error", requestId, publicAiFailureCode(error), {
    engine: engine.id,
    status,
  });
  return {
    error: reason,
    engine: engine.id,
    label: `${engine.label} (${engine.vendor})`,
    retryable: isTransientAiFailure(error),
    code: publicAiFailureCode(error),
    status,
  };
}

function isClientAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error as Error)?.name === "AbortError";
}

type GenerationDeadlines = ReturnType<typeof generationDeadlines>;

interface OrchestratedText {
  text: string;
  engine: ReturnType<typeof getEngine>["id"];
  fallbackUsed: boolean;
}

function paramsForProviderPhase(params: GenerateParams, phase: string): GenerateParams {
  if (!params.providerRequestKey) return params;
  return {
    ...params,
    providerRequestKey: aiRequestFingerprint({
      scope: "aurora-ai-provider-phase-v1",
      base: params.providerRequestKey,
      phase,
    }),
  };
}

interface CombinedValidation {
  post: ReturnType<typeof validatePostSettingsResult> | null;
  channelQuality: ReturnType<typeof validatePostQuality> | null;
  factual: FactualValidationResult | null;
  topic: TopicAlignmentResult | null;
  passed: boolean;
  blocked: boolean;
  requiresReview: boolean;
  issues: string[];
  errorCode: "post_validation_failed" | "factual_validation_failed" | "topic_alignment_failed";
}

async function runOrchestratedText(
  params: GenerateParams,
  engineId: ReturnType<typeof getEngine>["id"],
  signal: AbortSignal,
  requestId: string,
  deadlines: GenerationDeadlines,
  send: (event: AiStreamEvent) => boolean,
  emitDeltas: boolean,
): Promise<OrchestratedText> {
  let text = "";
  let engine = engineId;
  let fallbackUsed = false;
  const failClosed = () => {
    throw new DOMException("AI stream consumer closed", "AbortError");
  };
  for await (const event of orchestrateText(params, engineId, {
    signal,
    // Model choice belongs to the user. Runtime failures preserve the selected model
    // and return one ready suggestion that requires explicit confirmation in the UI.
    fallbackEngines: [],
    firstTokenMs: deadlines.firstTokenMs,
    overallMs: deadlines.attemptOverallMs,
  })) {
    if (event.type === "delta") {
      text += event.text;
      engine = event.engine;
      if (emitDeltas && !send({ type: "delta", requestId, text: event.text })) failClosed();
    } else if (event.type === "fallback") {
      fallbackUsed = true;
      if (!send({ requestId, ...event })) failClosed();
    } else {
      const telemetry: AiOrchestrationEvent & { type: "telemetry" } = event;
      if (!send({ requestId, ...telemetry })) failClosed();
    }
  }
  const result = text.trim();
  if (!result) throw new AiProviderError(engine, 502, "empty_generation");
  return { text: result, engine, fallbackUsed };
}

async function readyAlternative(chosen: EngineId): Promise<EngineId | null> {
  const candidates = [
    ...configuredFallbackEngines(chosen),
    ...ENGINES.filter((engine) => engine.recommended).map((engine) => engine.id),
    ...ENGINES.map((engine) => engine.id),
  ].filter((engine, index, all): engine is EngineId => engine !== chosen && all.indexOf(engine) === index);
  for (const candidate of candidates) {
    const runtime = resolveEngineRuntime(candidate);
    if (!runtime.supported || !runtime.configured) continue;
    if (await aiReady(candidate)) return candidate;
  }
  return null;
}

async function failurePayloadWithAlternative(
  requestId: string,
  error: unknown,
  engineId: EngineId,
) {
  const failure = failurePayload(requestId, error, engineId);
  const providerUnavailable = error instanceof AiProviderError
    || error instanceof TypeError
    || (error instanceof Error && error.name === "TimeoutError");
  if (!providerUnavailable) return { ...failure, suggestedEngine: null };
  const failedEngine = error instanceof AiProviderError ? error.engineId : engineId;
  const suggested = await readyAlternative(failedEngine).catch(() => null);
  if (!suggested) return { ...failure, suggestedEngine: null };
  const engine = getEngine(suggested);
  return {
    ...failure,
    suggestedEngine: { id: engine.id, label: engine.label, vendor: engine.vendor },
  };
}

function replayResponse(requestId: string, result: AiUsageStoredResult, used: number | null = null) {
  const events: AiStreamEvent[] = [
    { type: "replace", requestId, text: result.text, pipeline: result.pipeline },
    ...(result.validation
      ? [{
          type: "validation" as const,
          requestId,
          status: result.validation.status,
          requiresReview: result.validation.requiresReview,
          provenance: result.validation.provenance as unknown as FactualValidationProvenance,
          blockerCodes: result.validation.blockerCodes,
          ...(result.validation.topicAlignment
            ? { topicAlignment: result.validation.topicAlignment }
            : {}),
        }]
      : []),
    {
      type: "done",
      requestId,
      pipeline: result.pipeline,
      engine: result.engine,
      requestedEngine: result.requestedEngine,
      fallbackUsed: result.fallbackUsed,
      replayed: true,
      ackRequired: true,
    },
  ];
  // Stored validation provenance was produced by this route. The cast is only needed
  // because the durable JSON type intentionally avoids importing the ledger module.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encodeAiStreamEvent(event));
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": AI_STREAM_CONTENT_TYPE,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-accel-buffering": "no",
      "x-ai-request-id": requestId,
      "x-ai-engine": result.engine,
      "x-ai-requested-engine": result.requestedEngine,
      "x-ai-fallback": String(result.fallbackUsed),
      "x-ai-replayed": "true",
      "x-ai-ack-required": "true",
      ...(used === null ? {} : { "x-ai-used": String(used) }),
      "x-ai-limit": String(AI_DAILY_LIMIT),
    },
  });
}

function studioStreamResponse(
  requestId: string,
  params: GenerateParams,
  engineId: ReturnType<typeof getEngine>["id"],
  signal: AbortSignal,
  userId: number,
  reservationId: number | null,
  used: number,
  editorial: boolean,
  factLedger: FactLedger,
  semanticAdapter: SemanticEntailmentAdapter | null,
  allowReviewableBlockedDraft = false,
) {
  const settings = normalizePostSettings(params.postSettings);
  const deadlines = generationDeadlines(settings.qualityMode);
  const consumerAbort = new AbortController();
  const consumerSignal = AbortSignal.any([signal, consumerAbort.signal]);
  // Один общий deadline не позволяет трём редакторским проходам сложиться в 3×90 секунд.
  const pipelineSignal = AbortSignal.any([consumerSignal, AbortSignal.timeout(deadlines.pipelineOverallMs)]);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: AiStreamEvent) => {
        if (closed) return false;
        try {
          controller.enqueue(encodeAiStreamEvent(event));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Клиент уже отменил поток.
        }
      };
      const shouldValidatePostSettings = Boolean(
        params.postSettings
        && VALIDATED_POST_KINDS.includes(params.kind)
        && params.role !== "critic",
      );
      const shouldValidateChannelQuality = Boolean(
        params.channelQuality
        && CHANNEL_QUALITY_KINDS.includes(params.kind)
        && params.role !== "critic",
      );
      const validateResult = async (text: string): Promise<CombinedValidation> => {
        const post = shouldValidatePostSettings
          ? validatePostSettingsResult(text, params.postSettings, {
              network: params.network,
              kind: params.kind,
              task: params.task,
            })
          : null;
        // No production semantic adapter is registered: draft/ledger content is not sent
        // to an extra provider and the result remains visibly requires_review.
        const factual = await validateFactualOutputWithSemantics(text, factLedger, {
          signal: pipelineSignal,
          adapter: semanticAdapter,
        });
        const supportCount = factLedger.evidence.filter((item) => item.countsForCapacity !== false).length;
        const channelQuality = shouldValidateChannelQuality
          ? validatePostQuality(text, params.channelQuality, {
              supportCount,
              // Семантический ledger ниже остаётся источником правды о фактах. Здесь единица
              // означает лишь наличие серверных источников, чтобы второй валидатор не требовал
              // от публичного поста внутренних ссылок вида [1].
              citedShare: supportCount > 0 && factual.status !== "blocked" ? 1 : null,
              trigger: params.draft ? "rewrite" : "generation",
            })
          : null;
        const factualIssues = buildFactualRepairInstructions(factual);
        const postIssues = post ? buildPostRepairInstructions(post) : [];
        const channelIssues = channelQuality?.violations.map((item) => item.message) ?? [];
        const topic = params.referenceAdaptation
          ? validateTopicAlignment(text, params.referenceAdaptation)
          : null;
        const topicIssues = topic ? buildTopicRepairInstructions(topic) : [];
        const postPassed = post?.passed ?? true;
        const channelPassed = channelQuality?.passed ?? true;
        const topicPassed = topic?.status !== "failed";
        const blocked = !postPassed || !channelPassed || factual.status === "blocked" || !topicPassed;
        return {
          post,
          channelQuality,
          factual,
          topic,
          passed: postPassed && channelPassed && factual.status === "passed" && topicPassed,
          blocked,
          // A generation may be a useful draft even when it is not publishable yet.
          // Publication remains fail-closed; the stream itself can still finish durably.
          requiresReview: factual.requiresReview || blocked,
          issues: [...topicIssues, ...factualIssues, ...channelIssues, ...postIssues].slice(0, 16),
          errorCode: !topicPassed
            ? "topic_alignment_failed"
            : factual.status === "blocked"
              ? "factual_validation_failed"
              : "post_validation_failed",
        };
      };
      const sendValidation = (validation: CombinedValidation) => {
        if (!validation.factual) return true;
        const postBlockerCodes = validation.post?.violations
          .filter((item) => item.blocker)
          .map((item) => `post:${item.code}`) ?? [];
        const channelBlockerCodes = validation.channelQuality?.violations
          .filter((item) => item.blocker)
          .map((item) => `channel:${item.code}`) ?? [];
        return send({
          type: "validation",
          requestId,
          status: validation.blocked ? "blocked" : validation.factual.status,
          requiresReview: validation.requiresReview,
          provenance: validation.factual.provenance,
          blockerCodes: [
            ...validation.factual.violations.map((item) => item.code),
            ...channelBlockerCodes,
            ...postBlockerCodes,
            ...(validation.topic?.status === "failed" ? ["topic:off_topic"] : []),
          ],
          ...(validation.topic
            ? { topicAlignment: {
                status: validation.topic.status,
                score: validation.topic.score,
                topic: validation.topic.topic,
              } }
            : {}),
        });
      };
      const storedValidation = (validation: CombinedValidation): NonNullable<AiUsageStoredResult["validation"]> | undefined => {
        if (!validation.factual) return undefined;
        const postBlockerCodes = validation.post?.violations
          .filter((item) => item.blocker)
          .map((item) => `post:${item.code}`) ?? [];
        const channelBlockerCodes = validation.channelQuality?.violations
          .filter((item) => item.blocker)
          .map((item) => `channel:${item.code}`) ?? [];
        return {
          status: validation.blocked ? "blocked" : validation.factual.status,
          requiresReview: validation.requiresReview,
          provenance: validation.factual.provenance as unknown as Record<string, unknown>,
          blockerCodes: [
            ...validation.factual.violations.map((item) => item.code),
            ...channelBlockerCodes,
            ...postBlockerCodes,
            ...(validation.topic?.status === "failed" ? ["topic:off_topic"] : []),
          ],
          ...(validation.topic
            ? { topicAlignment: {
                status: validation.topic.status,
                score: validation.topic.score,
                topic: validation.topic.topic,
              } }
            : {}),
        };
      };
      const stageReservation = async (result: AiUsageStoredResult) => {
        const staged = await stageAiUsageResult(userId, reservationId, requestId, result).catch(() => {
          throw new AiUsageFinalizationError();
        });
        if (staged.status !== "reserved" || !staged.result) throw new AiUsageFinalizationError();
      };
      const stageAndSendTerminal = async (
        result: AiUsageStoredResult,
        terminal: Extract<AiStreamEvent, { type: "done" }>,
      ) => {
        await stageReservation(result);
        if (consumerSignal.aborted) {
          throw new DOMException("AI stream consumer closed", "AbortError");
        }
        // This is the sole terminal outcome. It never charges quota: only a client that
        // received `done` can ACK the staged result in the separate second phase.
        if (!send(terminal)) {
          throw new DOMException("AI stream consumer closed", "AbortError");
        }
      };

      let completed = false;
      let finalEngine = engineId;
      let anyFallback = false;
      try {
        if (!editorial) {
          if (!send({ type: "phase", requestId, phase: "writing" })) return;
          const generated = await runOrchestratedText(
            paramsForProviderPhase(params, "single"),
            engineId,
            pipelineSignal,
            requestId,
            deadlines,
            send,
            true,
          );
          finalEngine = generated.engine;
          anyFallback ||= generated.fallbackUsed;
          let finalText = generated.text;
          let finalPipeline: "single" | "editorial" = "single";
          let validation = await validateResult(finalText);
          if (validation.topic?.status === "failed") {
            if (!send({ type: "phase", requestId, phase: "editing" })) return;
            if (!send({ type: "replace", requestId, text: "", pipeline: "editorial" })) return;
            const repaired = await runOrchestratedText({
              ...paramsForProviderPhase(params, "topic-repair-1"),
              draft: finalText.slice(0, 12_000),
              validationIssues: buildTopicRepairInstructions(validation.topic),
            }, finalEngine, pipelineSignal, requestId, deadlines, send, true);
            finalText = repaired.text;
            finalEngine = repaired.engine;
            anyFallback ||= repaired.fallbackUsed;
            finalPipeline = "editorial";
            validation = await validateResult(finalText);
          }
          if (!sendValidation(validation)) return;
          if (validation.topic?.status === "failed" && !allowReviewableBlockedDraft) {
            throw new PostSettingsValidationError(validation.issues, "topic_alignment_failed");
          }
          // Фактологические blockers всегда fail-closed. Форматные — как и раньше,
          // только если включено скрытие критичного результата.
          if (validation.factual?.status === "blocked" && !allowReviewableBlockedDraft) {
            throw new PostSettingsValidationError(validation.issues, "factual_validation_failed");
          }
          if (
            ((validation.post && !validation.post.passed)
              || (validation.channelQuality && !validation.channelQuality.passed))
            && settings.hideCriticalResult
            && !allowReviewableBlockedDraft
          ) {
            throw new PostSettingsValidationError(validation.issues);
          }
          if (!send({ type: "replace", requestId, text: finalText, pipeline: finalPipeline })) return;
          await stageAndSendTerminal(
            {
              protocol: "ndjson",
              text: finalText,
              pipeline: finalPipeline,
              requestedEngine: engineId,
              engine: finalEngine,
              fallbackUsed: anyFallback,
              validation: storedValidation(validation),
            },
            {
              type: "done",
              pipeline: finalPipeline,
              requestId,
              engine: finalEngine,
              requestedEngine: engineId,
              fallbackUsed: anyFallback,
              ackRequired: true,
            },
          );
          completed = true;
          return;
        }

        if (!send({ type: "phase", requestId, phase: "draft" })) return;
        const generatedDraft = await runOrchestratedText(
          paramsForProviderPhase(params, "editorial-draft"),
          engineId,
          pipelineSignal,
          requestId,
          deadlines,
          send,
          true,
        );
        const draft = generatedDraft.text;
        finalEngine = generatedDraft.engine;
        anyFallback ||= generatedDraft.fallbackUsed;
        const draftValidation = await validateResult(draft);
        let topicRepairAttempted = draftValidation.topic?.status === "failed";

        if (!send({ type: "phase", requestId, phase: "editing" })) return;
        // Клиент уже умеет replace: очищаем provisional draft и стримим редакторский текст
        // с первого delta, не склеивая два прохода.
        if (!send({ type: "replace", requestId, text: "", pipeline: "editorial" })) return;
        let finalText = "";
        let edited = await runOrchestratedText({
          ...paramsForProviderPhase(params, "editorial-edit-1"),
          draft: draft.slice(0, 12_000),
          validationIssues: draftValidation.issues,
        }, finalEngine, pipelineSignal, requestId, deadlines, send, true);
        finalText = edited.text;
        finalEngine = edited.engine;
        anyFallback ||= edited.fallbackUsed;
        let validation = await validateResult(finalText);

        if (validation.blocked && validation.topic?.status !== "failed" && settings.autoImprove) {
          if (!send({ type: "phase", requestId, phase: "editing" })) return;
          if (!send({ type: "replace", requestId, text: "", pipeline: "editorial" })) return;
          edited = await runOrchestratedText({
            ...paramsForProviderPhase(params, "editorial-edit-2"),
            draft: finalText.slice(0, 12_000),
            validationIssues: validation.issues,
          }, finalEngine, pipelineSignal, requestId, deadlines, send, true);
          finalText = edited.text;
          finalEngine = edited.engine;
          anyFallback ||= edited.fallbackUsed;
          validation = await validateResult(finalText);
        }

        if (validation.topic?.status === "failed" && !topicRepairAttempted) {
          topicRepairAttempted = true;
          if (!send({ type: "phase", requestId, phase: "editing" })) return;
          if (!send({ type: "replace", requestId, text: "", pipeline: "editorial" })) return;
          edited = await runOrchestratedText({
            ...paramsForProviderPhase(params, "topic-repair-1"),
            draft: finalText.slice(0, 12_000),
            validationIssues: buildTopicRepairInstructions(validation.topic),
          }, finalEngine, pipelineSignal, requestId, deadlines, send, true);
          finalText = edited.text;
          finalEngine = edited.engine;
          anyFallback ||= edited.fallbackUsed;
          validation = await validateResult(finalText);
        }

        if (!sendValidation(validation)) return;
        if (validation.topic?.status === "failed" && !allowReviewableBlockedDraft) {
          throw new PostSettingsValidationError(validation.issues, "topic_alignment_failed");
        }
        if (validation.blocked && !allowReviewableBlockedDraft) {
          throw new PostSettingsValidationError(validation.issues, validation.errorCode);
        }
        if (!send({ type: "replace", requestId, text: finalText, pipeline: "editorial" })) return;
        await stageAndSendTerminal(
          {
            protocol: "ndjson",
            text: finalText,
            pipeline: "editorial",
            requestedEngine: engineId,
            engine: finalEngine,
            fallbackUsed: anyFallback,
            validation: storedValidation(validation),
          },
          {
            type: "done",
            pipeline: "editorial",
            requestId,
            engine: finalEngine,
            requestedEngine: engineId,
            fallbackUsed: anyFallback,
            ackRequired: true,
          },
        );
        completed = true;
      } catch (error) {
        if (!isClientAbort(error, consumerSignal)) {
          const failure = await failurePayloadWithAlternative(requestId, error, finalEngine);
          send({ type: "error", requestId, ...failure });
        }
      } finally {
        if (!completed) {
          await releaseAiUsageRequest(userId, reservationId, requestId).catch((error) => {
            void error;
            logAiRequest("error", requestId, "usage_release_failed", { engine: finalEngine });
          });
        }
        close();
      }
    },
    cancel() {
      consumerAbort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": AI_STREAM_CONTENT_TYPE,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-accel-buffering": "no",
      "x-ai-request-id": requestId,
      "x-ai-requested-engine": engineId,
      "x-ai-used": String(used),
      "x-ai-limit": String(AI_DAILY_LIMIT),
      "x-ai-pipeline": editorial ? "author-editor-stream" : "single-pass-stream",
      "x-ai-ack-required": "true",
    },
  });
}

export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    logAiRequest("warn", requestId, "forbidden_origin", { status: 403 });
    return aiJson(requestId, { error: "forbidden_origin", retryable: false }, { status: 403 });
  }
  let user: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    user = await getSessionUser(req);
  } catch (error) {
    return prerequisiteUnavailable(requestId, error, "session");
  }
  if (!user) return aiJson(requestId, { error: "unauthorized", retryable: false }, { status: 401 });

  let body: {
    command?: unknown;
    input?: unknown;
    context?: unknown;
    niche?: unknown;
    tone?: unknown;
    role?: unknown;
    surface?: unknown;
    channelId?: unknown;
    history?: unknown;
    postSettings?: unknown;
    referenceText?: unknown;
    referenceSource?: unknown;
    referenceDraftId?: unknown;
    referenceDraftVersion?: unknown;
    referenceIntent?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return aiJson(requestId, { error: "bad_request", retryable: false }, { status: 400 });
  }

  const requestKey = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9:_-]{8,96}$/u.test(requestKey)) {
    return aiJson(requestId, { error: "idempotency_key_required", retryable: false }, { status: 400 });
  }
  const requestedChannelId = Number(body.channelId);
  let channelId = Number.isSafeInteger(requestedChannelId) && requestedChannelId > 0
    ? requestedChannelId
    : null;
  const rawReferenceDraftId = body.referenceDraftId;
  const rawReferenceDraftVersion = body.referenceDraftVersion;
  const hasReferenceDraft = rawReferenceDraftId != null || rawReferenceDraftVersion != null;
  const referenceDraftId = Number(rawReferenceDraftId);
  const referenceDraftVersion = Number(rawReferenceDraftVersion);
  const referenceIntent = body.referenceIntent === "create" ? "create" : "discuss";
  if (hasReferenceDraft && (
    !Number.isSafeInteger(referenceDraftId)
    || referenceDraftId <= 0
    || !Number.isSafeInteger(referenceDraftVersion)
    || referenceDraftVersion <= 0
  )) {
    return aiJson(requestId, { error: "bad_reference_draft", retryable: false }, { status: 400 });
  }

  let referenceContext: ReferenceAdaptationContext | null = null;
  let referenceDestinationTitle: string | null = null;
  if (hasReferenceDraft) {
    let referenceDraft: Awaited<ReturnType<typeof getDraftForUser>>;
    try {
      referenceDraft = await getDraftForUser(user.id, referenceDraftId);
    } catch (error) {
      return prerequisiteUnavailable(requestId, error, "context");
    }
    if (!referenceDraft) {
      // Same response for a missing and a foreign draft: ownership is not disclosed.
      return aiJson(requestId, { error: "reference_draft_forbidden", retryable: false }, { status: 403 });
    }
    if (referenceDraft.version !== referenceDraftVersion) {
      return aiJson(requestId, { error: "reference_draft_version_conflict", retryable: false }, { status: 409 });
    }
    const activeDestinations = referenceDraft.destinations.filter((destination) => destination.is_active);
    const destination = channelId == null
      ? activeDestinations[0]
      : activeDestinations.find((candidate) => candidate.channel_id === channelId);
    if (!destination) {
      return aiJson(requestId, { error: "reference_draft_forbidden", retryable: false }, { status: 403 });
    }
    channelId = destination.channel_id;
    referenceDestinationTitle = destination.title;
    referenceContext = referenceAdaptationContextFromDraft(referenceDraft);
    if (!referenceContext) {
      return aiJson(requestId, { error: "bad_reference_context", retryable: false }, { status: 422 });
    }
  }
  const usageKey = `web:${requestKey}`;
  const requestFingerprint = aiRequestFingerprint(hasReferenceDraft
    ? { ...body, referenceText: undefined, referenceSource: undefined }
    : body);
  try {
    const existing = await lookupAiUsageRequest(user.id, usageKey, requestFingerprint);
    if ((existing.state === "replay" || existing.state === "terminal_pending_ack") && existing.result) {
      logAiRequest("info", requestId, "request_replayed", { engine: existing.result.engine });
      return replayResponse(requestId, existing.result);
    }
    if (existing.state === "in_progress") {
      return aiJson(
        requestId,
        { error: "request_in_progress", retryable: true, retryAfterSeconds: 2 },
        { status: 409, headers: { "retry-after": "2" } },
      );
    }
    if (existing.state === "committed_without_result") {
      return aiJson(
        requestId,
        { error: "request_result_unavailable", retryable: false },
        { status: 409 },
      );
    }
    if (existing.state === "conflict") {
      return aiJson(
        requestId,
        { error: "idempotency_key_conflict", retryable: false },
        { status: 409 },
      );
    }
  } catch {
    logAiRequest("error", requestId, "usage_lookup_unavailable", { status: 503 });
    return aiJson(
      requestId,
      { error: "usage_unavailable", retryable: true, retryAfterSeconds: 30 },
      { status: 503, headers: { "retry-after": "30" } },
    );
  }

  const kind: AiKind = KINDS.includes(body.command as AiKind) ? (body.command as AiKind) : "write";
  const requestedTask = String(body.input ?? "").trim().slice(0, 8000);
  const interactiveStream = body.surface === "studio" || body.surface === "composer";
  // Every paid text call below uses the same explicit validation + done + client ACK
  // contract. The legacy plain-text stream cannot prove terminal delivery and is gone.
  const referenceText = interactiveStream ? String(body.referenceText ?? "").trim().slice(0, 4000) : "";
  const referenceSource = referenceText ? String(body.referenceSource ?? "").trim().slice(0, 160) : "";
  const context = !interactiveStream && body.context ? String(body.context).slice(0, 600) : undefined;
  const niche = body.niche ? String(body.niche).slice(0, 120) : undefined;
  const tone = body.tone ? String(body.tone).slice(0, 120) : undefined;
  const role: AiRole | undefined = ROLES.includes(body.role as AiRole) ? (body.role as AiRole) : undefined;
  const conversation = referenceContext && referenceIntent === "create" ? [] : cleanHistory(body.history);
  if (
    body.postSettings !== undefined
    && (!body.postSettings || typeof body.postSettings !== "object" || Array.isArray(body.postSettings))
  ) {
    return aiJson(requestId, { error: "bad_post_settings", retryable: false }, { status: 422 });
  }

  // Картинки этот движок не умеет — честно, без выдумки (ТЗ Д.8: для картинок нужен
  // отдельный сервис IMAGE_API_KEY). Лимит на это не тратим.
  if (kind === "image") {
    const msg =
      "Картинки я пока не рисую — для этого нужен отдельный сервис генерации изображений, его подключим позже. А текст поста, план на неделю или сценарий видео — попроси, сделаю.";
    return new Response(msg, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-ai-request-id": requestId,
      },
    });
  }

  // Настроение и выбранный движок берём из БД (источник правды на сервере, клиент не подделает).
  let me: { ai_mood: string | null; ai_engine: string | null; ai_post_settings: unknown } | undefined;
  try {
    me = (
      await getPool().query<{ ai_mood: string | null; ai_engine: string | null; ai_post_settings: unknown }>(
        `select ai_mood, ai_engine, ai_post_settings from users where id = $1`,
        [user.id],
      )
    ).rows[0];
  } catch (error) {
    return prerequisiteUnavailable(requestId, error, "settings");
  }
  if (!me) {
    return prerequisiteUnavailable(requestId, new Error("settings row missing"), "settings");
  }
  const mood = me?.ai_mood;
  const postSettings = normalizePostSettings(body.postSettings ?? me?.ai_post_settings);
  const effectivePostSettings = referenceContext && referenceIntent === "create"
    ? { ...postSettings, mainIdea: "" }
    : postSettings;
  const task = referenceContext && referenceIntent === "create"
    ? buildReferenceAdaptationTask(referenceContext, referenceDestinationTitle || "выбранного канала")
    : requestedTask || effectivePostSettings.mainIdea;
  if (!task && kind !== "plan") {
    return aiJson(requestId, { error: "empty", retryable: false }, { status: 422 });
  }
  const settingsConflicts = validatePostSettingsConflicts(effectivePostSettings);
  const blockingConflicts = settingsConflicts.filter((item) => item.severity === "error");
  if (blockingConflicts.length) {
    return aiJson(
      requestId,
      { error: "post_settings_conflict", conflicts: blockingConflicts },
      { status: 422 },
    );
  }

  // Человек выбрал облачный движок, а ключа нет — честно отказываем. Писать тайком локальной
  // моделью и выдавать это за выбранную — ровно тот обман, которого продукт не допускает.
  // Выбор при этом сохранён: появится ключ — заработает без правок.
  const chosen = isEngineId(me?.ai_engine) ? me.ai_engine : DEFAULT_ENGINE;
  const runtime = resolveEngineRuntime(chosen);
  if (!runtime.supported) {
    const e = getEngine(chosen);
    const suggested = await readyAlternative(chosen);
    return aiJson(
      requestId,
      {
        error: "engine_unsupported",
        engine: e.id,
        label: `${e.label} (${e.vendor})`,
        needs: e.needs,
        retryable: false,
        suggestedEngine: suggested ? getEngine(suggested) : null,
      },
      { status: 503 },
    );
  }
  if (!runtime.configured) {
    const e = getEngine(chosen);
    const suggested = await readyAlternative(chosen);
    return aiJson(
      requestId,
      {
        error: "engine_not_connected",
        engine: e.id,
        label: `${e.label} (${e.vendor})`,
        needs: e.needs,
        retryable: false,
        suggestedEngine: suggested ? getEngine(suggested) : null,
      },
      { status: 503 },
    );
  }
  if (!await aiReady(chosen)) {
    const e = getEngine(chosen);
    const suggested = await readyAlternative(chosen);
    return aiJson(
      requestId,
      {
        error: "engine_offline",
        engine: e.id,
        label: `${e.label} (${e.vendor})`,
        retryable: true,
        suggestedEngine: suggested ? getEngine(suggested) : null,
      },
      { status: 503, headers: { "retry-after": "15" } },
    );
  }
  const styleLimit = effectivePostSettings.originalityDepth === "all" ? 200 : Number(effectivePostSettings.originalityDepth);
  let channel: Awaited<ReturnType<typeof channelAiContextFor>>;
  try {
    channel = await channelAiContextFor(user.id, channelId, styleLimit);
  } catch (error) {
    return prerequisiteUnavailable(requestId, error, "context");
  }
  if (channelId && !channel) {
    return aiJson(requestId, { error: "channel_not_found", retryable: false }, { status: 422 });
  }

  const params: GenerateParams = {
    kind,
    task,
    providerRequestKey: aiRequestFingerprint({
      scope: "aurora-ai-provider-request-v1",
      userId: user.id,
      requestKey,
      requestFingerprint,
      engine: chosen,
      model: runtime.model,
    }),
    providerRequestId: requestId,
    referenceAdaptation: referenceContext && referenceIntent === "create" ? referenceContext : undefined,
    mechanicReference: referenceContext && referenceIntent === "discuss"
      ? { text: referenceContext.sourceText, source: referenceContext.sourceLabel }
      : referenceText
      ? { text: referenceText, source: referenceSource || undefined }
      : undefined,
    context,
    // Паспорт подключённого канала — источник правды. Общая ниша из settings нужна
    // только как fallback для ещё не проанализированного канала: иначе старая настройка
    // «кофе» могла увести пост канала о технологиях и праве в совершенно чужую тему.
    niche: channel?.profile ? undefined : niche,
    tone: channel?.profile ? undefined : tone,
    mood: mood ?? undefined,
    role,
    channelTitle: channel?.title,
    network: channel?.network,
    channelProfile: channel?.profile,
    channelQuality: channel?.quality,
    channelPostIndex: channel?.postIndex,
    knownFacts: channel?.facts,
    conversation,
    postSettings: effectivePostSettings,
    grounding: interactiveStream ? "platform" : undefined,
    styleSamples: channel?.styleSamples ?? (await styleSamplesFor(user.id, null, styleLimit)),
  };

  const factLedger = buildFactLedger({
    task,
    postSettings: effectivePostSettings,
    knownFacts: channel?.facts,
    profile: channel?.profile,
  });
  const factPreflight = preflightFactLedger(factLedger);
  if (!factPreflight.passed) {
    return aiJson(
      requestId,
      { error: "brief_insufficient_facts", issues: factPreflight.issues },
      { status: 422 },
    );
  }
  const semanticAdapter = createConfiguredSemanticAdapter() as SemanticEntailmentAdapter | null;

  // Резервируем квоту атомарно непосредственно перед платным вызовом. Параллельные
  // запросы одного аккаунта больше не могут все пройти на одном и том же count(*).
  let reservation;
  try {
    reservation = await acquireAiUsageRequest(user.id, kind, {
      reservationKey: usageKey,
      fingerprint: requestFingerprint,
      operationId: requestId,
    });
  } catch {
    logAiRequest("error", requestId, "usage_acquire_unavailable", { status: 503 });
    return aiJson(
      requestId,
      { error: "usage_unavailable", retryable: true, retryAfterSeconds: 30 },
      { status: 503, headers: { "retry-after": "30" } },
    );
  }
  if (
    (reservation.requestState === "replay" || reservation.requestState === "terminal_pending_ack")
    && reservation.result
  ) {
    return replayResponse(requestId, reservation.result, reservation.used || null);
  }
  if (reservation.requestState === "in_progress") {
    return aiJson(
      requestId,
      { error: "request_in_progress", retryable: true, retryAfterSeconds: 2 },
      { status: 409, headers: { "retry-after": "2" } },
    );
  }
  if (reservation.requestState === "conflict") {
    return aiJson(requestId, { error: "idempotency_key_conflict", retryable: false }, { status: 409 });
  }
  if (reservation.requestState === "committed_without_result") {
    return aiJson(requestId, { error: "request_result_unavailable", retryable: false }, { status: 409 });
  }
  if (!reservation.allowed) {
    return aiJson(
      requestId,
      { error: "limit", used: reservation.used, limit: reservation.limit },
      { status: 429 },
    );
  }

  const editorial = interactiveStream
    && effectivePostSettings.qualityMode !== "fast"
    && EDITORIAL_KINDS.includes(kind)
    && role !== "critic";
  return studioStreamResponse(
    requestId,
    params,
    chosen,
    req.signal,
    user.id,
    reservation.reservationId,
    reservation.used,
    editorial,
    factLedger,
    semanticAdapter,
    interactiveStream || body.surface === "trends",
  );
}
