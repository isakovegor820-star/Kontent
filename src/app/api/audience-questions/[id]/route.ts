import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import {
  buildAudienceQuestionPrompt,
  getAudienceQuestion,
  updateAudienceQuestion,
} from "@/lib/audience-questions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  audienceQuestionApiError,
  audienceQuestionBody,
  audienceQuestionBodyFailure,
  audienceQuestionJson,
  audienceQuestionRouteId,
} from "../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return audienceQuestionJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const questionId = audienceQuestionRouteId((await params).id);
  if (!questionId) return audienceQuestionJson({ ok: false, error: "bad_question" }, 400, requestId);
  try {
    const question = await getAudienceQuestion({ actorUserId: user.id, questionId });
    return audienceQuestionJson(
      { ok: true, question, generationPrompt: buildAudienceQuestionPrompt(question) },
      200,
      requestId,
    );
  } catch (error) {
    return audienceQuestionApiError(error, requestId);
  }
}

export async function PATCH(request: NextRequest, { params }: Context) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) {
    return audienceQuestionJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  }
  const user = await getSessionUser(request);
  if (!user) return audienceQuestionJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const questionId = audienceQuestionRouteId((await params).id);
  if (!questionId) return audienceQuestionJson({ ok: false, error: "bad_question" }, 400, requestId);
  const rate = await checkRateLimit(`audience-question:update:user:${user.id}`, 240, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await audienceQuestionBody(request, [
    "expectedVersion", "status", "priority", "topic", "answerDraftId",
  ]);
  if (!parsed.ok) return audienceQuestionBodyFailure(parsed.error, requestId);
  try {
    const question = await updateAudienceQuestion({
      actorUserId: user.id,
      questionId,
      expectedVersion: parsed.body.expectedVersion,
      status: parsed.body.status,
      priority: parsed.body.priority,
      topic: parsed.body.topic,
      answerDraftId: parsed.body.answerDraftId,
    });
    return audienceQuestionJson({ ok: true, question }, 200, requestId);
  } catch (error) {
    return audienceQuestionApiError(error, requestId);
  }
}
