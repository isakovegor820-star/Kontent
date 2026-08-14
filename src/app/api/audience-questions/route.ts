import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { createAudienceQuestion, listAudienceQuestions } from "@/lib/audience-questions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  audienceQuestionApiError,
  audienceQuestionBody,
  audienceQuestionBodyFailure,
  audienceQuestionJson,
} from "./_shared";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return audienceQuestionJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    return audienceQuestionJson(
      { ok: true, ...(await listAudienceQuestions({ actorUserId: user.id })) },
      200,
      requestId,
    );
  } catch (error) {
    return audienceQuestionApiError(error, requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) {
    return audienceQuestionJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  }
  const user = await getSessionUser(request);
  if (!user) return audienceQuestionJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`audience-question:create:user:${user.id}`, 120, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await audienceQuestionBody(request, [
    "requestKey", "question", "topic", "priority", "occurrences",
    "sourceType", "sourceLabel", "sourceUrl", "context",
  ]);
  if (!parsed.ok) return audienceQuestionBodyFailure(parsed.error, requestId);
  try {
    const result = await createAudienceQuestion({
      actorUserId: user.id,
      requestKey: parsed.body.requestKey,
      question: parsed.body.question,
      topic: parsed.body.topic,
      priority: parsed.body.priority,
      occurrences: parsed.body.occurrences,
      sourceType: parsed.body.sourceType,
      sourceLabel: parsed.body.sourceLabel,
      sourceUrl: parsed.body.sourceUrl,
      context: parsed.body.context,
    });
    return audienceQuestionJson({ ok: true, ...result }, result.duplicate ? 200 : 201, requestId);
  } catch (error) {
    return audienceQuestionApiError(error, requestId);
  }
}
