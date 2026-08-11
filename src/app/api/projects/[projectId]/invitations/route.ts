import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { configuredAppUrl } from "@/lib/password-reset";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { createProjectInvitation, listProjectInvitations } from "@/lib/project-team";
import { positiveRouteId, projectApiError, projectJson, readObjectBody } from "@/app/api/projects/_shared";

export const runtime = "nodejs";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const projectId = positiveRouteId((await params).projectId);
  if (!projectId) return projectJson({ ok: false, error: "bad_project" }, 400, requestId);
  try {
    const invitations = await listProjectInvitations({ pool: getPool(), actorUserId: user.id, projectId });
    return projectJson({ ok: true, invitations }, 200, requestId);
  } catch (error) {
    return projectApiError(error, requestId);
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  if (!hasTrustedMutationOrigin(req)) {
    return projectJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`project-invite:create:user:${user.id}`, 20, 3600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const projectId = positiveRouteId((await params).projectId);
  if (!projectId) return projectJson({ ok: false, error: "bad_project" }, 400, requestId);
  const body = await readObjectBody(req);
  if (!body) return projectJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const result = await createProjectInvitation({
      pool: getPool(),
      actorUserId: user.id,
      projectId,
      email: body.email,
      role: body.role,
      ttlDays: body.ttlDays,
      requestId,
    });
    const inviteUrlValue = new URL("/invite", configuredAppUrl() ?? req.nextUrl.origin);
    // The secret stays in the fragment: browsers do not send it in HTTP requests,
    // referrers or reverse-proxy access logs. The invitation page submits it once.
    inviteUrlValue.hash = `token=${encodeURIComponent(result.token)}`;
    const inviteUrl = inviteUrlValue.toString();
    return projectJson({ ok: true, invitation: result.invitation, inviteUrl }, 201, requestId);
  } catch (error) {
    return projectApiError(error, requestId);
  }
}
