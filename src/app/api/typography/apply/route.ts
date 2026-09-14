import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { applyProjectTypography } from "@/lib/typography-service";
import { readTypographyBody, typographyApiError, typographyJson } from "../_shared";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) {
    return typographyJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  }
  const user = await getSessionUser(request);
  if (!user) return typographyJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`typography:apply:user:${user.id}`, 240, 3_600, {
    failureMode: "closed",
  });
  if (!rate.allowed) return rateLimitResponse(rate);
  const body = await readTypographyBody(request, [
    "requestKey",
    "draftId",
    "text",
    "expectedDictionaryVersion",
    "acceptedSuggestionIds",
    "rejectedSuggestionIds",
    "formatQuotes",
  ]);
  if (!body) return typographyJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const run = await applyProjectTypography({
      pool: getPool(),
      actorUserId: user.id,
      requestKey: body.requestKey,
      draftId: body.draftId,
      text: body.text,
      expectedDictionaryVersion: body.expectedDictionaryVersion,
      acceptedSuggestionIds: body.acceptedSuggestionIds,
      rejectedSuggestionIds: body.rejectedSuggestionIds,
      formatQuotes: body.formatQuotes,
      requestId,
    });
    return typographyJson({ ok: true, run }, run.duplicate ? 200 : 201, requestId);
  } catch (error) {
    return typographyApiError(error, requestId);
  }
}
