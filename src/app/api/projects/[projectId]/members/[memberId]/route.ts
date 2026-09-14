import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { changeProjectMemberRole, revokeProjectMember } from "@/lib/project-context";
import { PROJECT_ROLES, type ProjectRole } from "@/lib/project-permissions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { positiveRouteId, projectApiError, projectBodyFailure, projectJson, readProjectBody } from "@/app/api/projects/_shared";

export const runtime = "nodejs";

type Params = { params: Promise<{ projectId: string; memberId: string }> };

function parsedIds(values: { projectId: string; memberId: string }) {
  return {
    projectId: positiveRouteId(values.projectId),
    memberId: positiveRouteId(values.memberId),
  };
}

export async function PATCH(req: NextRequest, { params }: Params) {
  if (!hasTrustedMutationOrigin(req)) {
    return projectJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`project:member:update:user:${user.id}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const ids = parsedIds(await params);
  if (!ids.projectId || !ids.memberId) {
    return projectJson({ ok: false, error: "bad_member" }, 400, requestId);
  }
  const parsed = await readProjectBody(req, ["role", "expectedVersion"]);
  if (!parsed.ok) return projectBodyFailure(parsed, requestId);
  const body = parsed.body;
  if (!PROJECT_ROLES.includes(body.role as ProjectRole)
      || typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion)
      || body.expectedVersion <= 0) {
    return projectJson({ ok: false, error: "bad_request" }, 400, requestId);
  }
  try {
    const member = await changeProjectMemberRole({
      pool: getPool(),
      actorUserId: user.id,
      projectId: ids.projectId,
      memberUserId: ids.memberId,
      role: body.role as ProjectRole,
      expectedVersion: body.expectedVersion,
      requestId,
    });
    return projectJson({ ok: true, member: { userId: ids.memberId, ...member } }, 200, requestId);
  } catch (error) {
    return projectApiError(error, requestId);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!hasTrustedMutationOrigin(req)) {
    return projectJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`project:member:delete:user:${user.id}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const ids = parsedIds(await params);
  if (!ids.projectId || !ids.memberId) {
    return projectJson({ ok: false, error: "bad_member" }, 400, requestId);
  }
  const parsed = await readProjectBody(req, ["expectedVersion"]);
  if (!parsed.ok) return projectBodyFailure(parsed, requestId);
  const body = parsed.body;
  if (typeof body.expectedVersion !== "number"
      || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion <= 0) {
    return projectJson({ ok: false, error: "bad_request" }, 400, requestId);
  }
  try {
    const member = await revokeProjectMember({
      pool: getPool(),
      actorUserId: user.id,
      projectId: ids.projectId,
      memberUserId: ids.memberId,
      expectedVersion: body.expectedVersion,
      requestId,
    });
    return projectJson({ ok: true, member: { userId: ids.memberId, status: "revoked", ...member } }, 200, requestId);
  } catch (error) {
    return projectApiError(error, requestId);
  }
}
