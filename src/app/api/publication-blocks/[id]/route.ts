import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { updateProjectPublicationBlock } from "@/lib/publication-settings-service";
import {
  publicationSettingsApiError,
  publicationSettingsJson,
  readPublicationSettingsBody,
} from "../../publication-settings/_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return publicationSettingsJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return publicationSettingsJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`publication-blocks:update:user:${user.id}`, 120, 3_600, {
    failureMode: "closed",
  });
  if (!rate.allowed) return rateLimitResponse(rate);
  const blockId = Number((await ctx.params).id);
  if (!Number.isSafeInteger(blockId) || blockId <= 0) {
    return publicationSettingsJson({ ok: false, error: "bad_id" }, 400, requestId);
  }
  const body = await readPublicationSettingsBody(req, [
    "expectedVersion",
    "kind",
    "name",
    "body",
    "enabled",
  ]);
  if (!body) return publicationSettingsJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const block = await updateProjectPublicationBlock({
      pool: getPool(),
      actorUserId: user.id,
      blockId,
      expectedVersion: body.expectedVersion,
      kind: body.kind,
      name: body.name,
      body: body.body,
      enabled: body.enabled,
      requestId,
    });
    return publicationSettingsJson({ ok: true, block }, 200, requestId);
  } catch (error) {
    return publicationSettingsApiError(error, requestId);
  }
}
