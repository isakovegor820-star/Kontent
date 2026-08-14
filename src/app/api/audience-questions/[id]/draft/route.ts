import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { linkAudienceQuestionDraft } from "@/lib/audience-questions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  audienceQuestionApiError,
  audienceQuestionBody,
  audienceQuestionBodyFailure,
  audienceQuestionJson,
  audienceQuestionRouteId,
} from "../../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) {
    return audienceQuestionJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  }
  const user = await getSessionUser(request);
  if (!user) return audienceQuestionJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const questionId = audienceQuestionRouteId((await params).id);
  if (!questionId) return audienceQuestionJson({ ok: false, error: "bad_question" }, 400, requestId);
  const rate = await checkRateLimit(`audience-question:link:user:${user.id}`, 120, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await audienceQuestionBody(request, ["generationRequestKey", "answerDraftId"]);
  if (!parsed.ok) return audienceQuestionBodyFailure(parsed.error, requestId);
  try {
    const question = await linkAudienceQuestionDraft({
      actorUserId: user.id,
      questionId,
      generationRequestKey: parsed.body.generationRequestKey,
      answerDraftId: parsed.body.answerDraftId,
    });
    return audienceQuestionJson({ ok: true, question }, 200, requestId);
  } catch (error) {
    return audienceQuestionApiError(error, requestId);
  }
}
