import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { archiveProjectUtmTemplate, updateProjectUtmTemplate } from "@/lib/tracking-service";
import { readTrackingBodyResult, trackingApiError, trackingBodyFailure, trackingJson } from "../../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

function routeId(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function mutationContext(req: NextRequest, ctx: Context) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return { response: trackingJson({ ok: false, error: "unauthorized" }, 401, requestId) };
  const id = routeId((await ctx.params).id);
  if (!id) return { response: trackingJson({ ok: false, error: "bad_id" }, 400, requestId) };
  const rate = await checkRateLimit(`tracking:templates:user:${user.id}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return { response: rateLimitResponse(rate) };
  return { requestId, user, id };
}

export async function PATCH(req: NextRequest, ctx: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return trackingJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const context = await mutationContext(req, ctx);
  if ("response" in context) return context.response;
  const parsed = await readTrackingBodyResult(req, ["expectedVersion", "name", "values"]);
  if (!parsed.ok) return trackingBodyFailure(parsed, context.requestId);
  const body = parsed.body;
  try {
    const template = await updateProjectUtmTemplate({
      pool: getPool(), actorUserId: context.user.id, templateId: context.id,
      expectedVersion: body.expectedVersion, name: body.name, values: body.values,
      requestId: context.requestId,
    });
    return trackingJson({ ok: true, template }, 200, context.requestId);
  } catch (error) {
    return trackingApiError(error, context.requestId);
  }
}

export async function DELETE(req: NextRequest, ctx: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return trackingJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const context = await mutationContext(req, ctx);
  if ("response" in context) return context.response;
  const parsed = await readTrackingBodyResult(req, ["expectedVersion"]);
  if (!parsed.ok) return trackingBodyFailure(parsed, context.requestId);
  const body = parsed.body;
  try {
    const result = await archiveProjectUtmTemplate({
      pool: getPool(), actorUserId: context.user.id, templateId: context.id,
      expectedVersion: body.expectedVersion, requestId: context.requestId,
    });
    return trackingJson({ ok: true, ...result }, 200, context.requestId);
  } catch (error) {
    return trackingApiError(error, context.requestId);
  }
}
