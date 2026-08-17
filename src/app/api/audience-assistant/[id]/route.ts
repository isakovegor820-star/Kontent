import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { updateAudienceInquiry } from "@/lib/audience-assistant";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  audienceAssistantApiError,
  audienceAssistantBody,
  audienceAssistantBodyFailure,
  audienceAssistantJson,
  audienceAssistantRouteId,
} from "../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Context) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) {
    return audienceAssistantJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  }
  const user = await getSessionUser(request);
  if (!user) return audienceAssistantJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const inquiryId = audienceAssistantRouteId((await params).id);
  if (!inquiryId) return audienceAssistantJson({ ok: false, error: "bad_inquiry" }, 400, requestId);
  const rate = await checkRateLimit(`audience-assistant:update:user:${user.id}`, 360, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await audienceAssistantBody(request, ["expectedVersion", "status", "suggestedReply"]);
  if (!parsed.ok) return audienceAssistantBodyFailure(parsed.error, requestId);
  try {
    const inquiry = await updateAudienceInquiry({
      actorUserId: user.id,
      inquiryId,
      expectedVersion: parsed.body.expectedVersion,
      status: parsed.body.status,
      suggestedReply: parsed.body.suggestedReply,
    });
    return audienceAssistantJson({ ok: true, inquiry }, 200, requestId);
  } catch (error) {
    return audienceAssistantApiError(error, requestId);
  }
}
