import type { AiAttemptOutcome, AiPublicFailureCode } from "./ai-orchestrator";
import type { FactualValidationProvenance } from "./fact-ledger";

export const AI_STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

export type AiStreamPipeline = "single" | "editorial" | "draft-fallback";

type AiStreamEventPayload =
  | { type: "phase"; phase: "draft" | "editing" | "writing" }
  | { type: "delta"; text: string }
  | { type: "replace"; text: string; pipeline: AiStreamPipeline }
  | {
      type: "fallback";
      fromEngine: string;
      toEngine: string;
      reason: AiPublicFailureCode;
      attempt: number;
    }
  | {
      type: "telemetry";
      engine: string;
      primary: boolean;
      attempt: number;
      outcome: AiAttemptOutcome;
      ttftMs?: number;
      totalMs?: number;
      code?: AiPublicFailureCode;
    }
  | {
      type: "validation";
      status: "passed" | "blocked" | "not_checked";
      requiresReview: boolean;
      provenance: FactualValidationProvenance;
      blockerCodes: string[];
      topicAlignment?: {
        status: "passed" | "failed";
        score: number;
        topic: string;
      };
    }
  | {
      type: "error";
      error: string;
      engine: string;
      label: string;
      retryable?: boolean;
      code?: string;
      status?: number | null;
      suggestedEngine?: { id: string; label: string; vendor?: string } | null;
    }
  | {
      type: "done";
      pipeline: AiStreamPipeline;
      engine?: string;
      requestedEngine?: string;
      fallbackUsed?: boolean;
      replayed?: boolean;
      ackRequired?: boolean;
    };

export type AiStreamEvent = AiStreamEventPayload & { requestId: string };

const encoder = new TextEncoder();

export function encodeAiStreamEvent(event: AiStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAiStreamEvent(value: unknown): value is AiStreamEvent {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.requestId !== "string" || !value.requestId) {
    return false;
  }
  if (value.type === "phase") return value.phase === "draft" || value.phase === "editing" || value.phase === "writing";
  if (value.type === "delta") return typeof value.text === "string";
  if (value.type === "replace") return typeof value.text === "string" && typeof value.pipeline === "string";
  if (value.type === "fallback") {
    return typeof value.fromEngine === "string"
      && typeof value.toEngine === "string"
      && typeof value.reason === "string"
      && Number.isInteger(value.attempt);
  }
  if (value.type === "telemetry") {
    return typeof value.engine === "string"
      && typeof value.primary === "boolean"
      && Number.isInteger(value.attempt)
      && typeof value.outcome === "string";
  }
  if (value.type === "validation") {
    return (value.status === "passed" || value.status === "blocked" || value.status === "not_checked")
      && typeof value.requiresReview === "boolean"
      && isRecord(value.provenance)
      && Array.isArray(value.blockerCodes);
  }
  if (value.type === "error") {
    const suggested = value.suggestedEngine;
    const validSuggestion = suggested === undefined
      || suggested === null
      || (isRecord(suggested) && typeof suggested.id === "string" && typeof suggested.label === "string");
    return typeof value.error === "string"
      && typeof value.engine === "string"
      && typeof value.label === "string"
      && validSuggestion;
  }
  return value.type === "done" && typeof value.pipeline === "string";
}

export function parseAiStreamBuffer(buffer: string): { events: AiStreamEvent[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: AiStreamEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (isAiStreamEvent(event)) events.push(event);
    } catch {
      // Повреждённое служебное событие не должно уничтожать уже полученный текст.
    }
  }
  return { events, rest };
}

export function finalizeAiClientStream(input: {
  text: string;
  failed: boolean;
  validationReceived: boolean;
  doneReceived: boolean;
  validationBlocked: boolean;
  validationRequiresReview: boolean;
}):
  | { status: "failed" }
  | { status: "truncated"; partialText: string }
  | {
      status: "complete";
      text: string;
      postable: boolean;
      reviewable: true;
      requiresReview: boolean;
    } {
  if (input.failed) return { status: "failed" };
  const text = input.text.trim();
  if (!input.validationReceived || !input.doneReceived) {
    return { status: "truncated", partialText: text };
  }
  if (!text) return { status: "truncated", partialText: "" };
  return {
    status: "complete",
    text,
    postable: !input.validationBlocked,
    reviewable: true,
    requiresReview: input.validationRequiresReview,
  };
}
