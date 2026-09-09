import { withProjectRoute } from "@/lib/project-route";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { createProjectUtmTemplate, listProjectUtmTemplates } from "@/lib/tracking-service";
import { readTrackingBodyResult, trackingApiError, trackingBodyFailure, trackingJson } from "../_shared";

export const runtime = "nodejs";

async function handleGET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return trackingJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    return trackingJson({ ok: true, templates: await listProjectUtmTemplates(getPool(), user.id) }, 200, requestId);
  } catch (error) {
    return trackingApiError(error, requestId);
  }
}

async function handlePOST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return trackingJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return trackingJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`tracking:templates:user:${user.id}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await readTrackingBodyResult(req, ["name", "values"]);
  if (!parsed.ok) return trackingBodyFailure(parsed, requestId);
  const body = parsed.body;
  try {
    const template = await createProjectUtmTemplate({
      pool: getPool(), actorUserId: user.id, name: body.name, values: body.values, requestId,
    });
    return trackingJson({ ok: true, template }, 201, requestId);
  } catch (error) {
    return trackingApiError(error, requestId);
  }
}

export const GET = withProjectRoute(handleGET);
export const POST = withProjectRoute(handlePOST);
