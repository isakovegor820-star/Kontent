import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  getDraftPublicationPreferences,
  saveDraftPublicationPreferences,
} from "@/lib/publication-settings-service";
import {
  publicationSettingsApiError,
  publicationSettingsJson,
  readPublicationSettingsBody,
} from "../../../publication-settings/_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

async function context(req: NextRequest, ctx: Context) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return { response: publicationSettingsJson({ ok: false, error: "unauthorized" }, 401, requestId) };
  const draftId = Number((await ctx.params).id);
  if (!Number.isSafeInteger(draftId) || draftId <= 0) {
    return { response: publicationSettingsJson({ ok: false, error: "bad_id" }, 400, requestId) };
  }
  return { requestId, user, draftId };
}

export async function GET(req: NextRequest, ctx: Context) {
  const resolved = await context(req, ctx);
  if ("response" in resolved) return resolved.response;
  try {
    const preferences = await getDraftPublicationPreferences(
      getPool(),
      resolved.user.id,
      resolved.draftId,
    );
    return publicationSettingsJson({ ok: true, preferences }, 200, resolved.requestId);
  } catch (error) {
    return publicationSettingsApiError(error, resolved.requestId);
  }
}

export async function PUT(req: NextRequest, ctx: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return publicationSettingsJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const resolved = await context(req, ctx);
  if ("response" in resolved) return resolved.response;
  const rate = await checkRateLimit(`publication-preferences:user:${resolved.user.id}`, 120, 3_600, {
    failureMode: "closed",
  });
  if (!rate.allowed) return rateLimitResponse(rate);
  const body = await readPublicationSettingsBody(req, [
    "expectedVersion",
    "selectedBlockIds",
    "firstCommentFallback",
    "commentsMode",
    "pinAfterPublish",
    "reviewAt",
    "reviewResponsibleUserId",
  ]);
  if (!body) return publicationSettingsJson({ ok: false, error: "bad_request" }, 400, resolved.requestId);
  try {
    const preferences = await saveDraftPublicationPreferences({
      pool: getPool(),
      actorUserId: resolved.user.id,
      draftId: resolved.draftId,
      expectedVersion: body.expectedVersion,
      selectedBlockIds: body.selectedBlockIds,
      firstCommentFallback: body.firstCommentFallback,
      commentsMode: body.commentsMode,
      pinAfterPublish: body.pinAfterPublish,
      reviewAt: body.reviewAt,
      reviewResponsibleUserId: body.reviewResponsibleUserId,
      requestId: resolved.requestId,
    });
    return publicationSettingsJson({ ok: true, preferences }, 200, resolved.requestId);
  } catch (error) {
    return publicationSettingsApiError(error, resolved.requestId);
  }
}
