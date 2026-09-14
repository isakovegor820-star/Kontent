import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { revokeProjectInvitation } from "@/lib/project-team";
import { positiveRouteId, projectApiError, projectJson } from "@/app/api/projects/_shared";

export const runtime = "nodejs";

type Params = { params: Promise<{ projectId: string; invitationId: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!hasTrustedMutationOrigin(req)) {
    return projectJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const values = await params;
  const projectId = positiveRouteId(values.projectId);
  const invitationId = positiveRouteId(values.invitationId);
  if (!projectId || !invitationId) {
    return projectJson({ ok: false, error: "bad_invitation" }, 400, requestId);
  }
  try {
    const result = await revokeProjectInvitation({
      pool: getPool(), actorUserId: user.id, projectId, invitationId, requestId,
    });
    return projectJson({ ok: true, status: "revoked", ...result }, 200, requestId);
  } catch (error) {
    return projectApiError(error, requestId);
  }
}
