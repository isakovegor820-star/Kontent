import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { createAudienceInquiry, listAudienceInquiries } from "@/lib/audience-assistant";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  audienceAssistantApiError,
  audienceAssistantBody,
  audienceAssistantBodyFailure,
  audienceAssistantJson,
} from "./_shared";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return audienceAssistantJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    return audienceAssistantJson(
      { ok: true, ...(await listAudienceInquiries({ actorUserId: user.id })) },
      200,
      requestId,
    );
  } catch (error) {
    return audienceAssistantApiError(error, requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) {
    return audienceAssistantJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  }
  const user = await getSessionUser(request);
  if (!user) return audienceAssistantJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`audience-assistant:create:user:${user.id}`, 240, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await audienceAssistantBody(request, [
    "requestKey", "sourceType", "sourceLabel", "sourceUrl",
    "authorName", "incomingText", "context",
  ]);
  if (!parsed.ok) return audienceAssistantBodyFailure(parsed.error, requestId);
  try {
    const result = await createAudienceInquiry({
      actorUserId: user.id,
      requestKey: parsed.body.requestKey,
      sourceType: parsed.body.sourceType,
      sourceLabel: parsed.body.sourceLabel,
      sourceUrl: parsed.body.sourceUrl,
      authorName: parsed.body.authorName,
      incomingText: parsed.body.incomingText,
      context: parsed.body.context,
    });
    return audienceAssistantJson({ ok: true, ...result }, result.duplicate ? 200 : 201, requestId);
  } catch (error) {
    return audienceAssistantApiError(error, requestId);
  }
}
