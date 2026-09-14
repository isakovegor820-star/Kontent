import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { listProjectMembers } from "@/lib/project-team";
import { positiveRouteId, projectApiError, projectJson } from "@/app/api/projects/_shared";

export const runtime = "nodejs";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const projectId = positiveRouteId((await params).projectId);
  if (!projectId) return projectJson({ ok: false, error: "bad_project" }, 400, requestId);
  try {
    const members = await listProjectMembers({ pool: getPool(), actorUserId: user.id, projectId });
    return projectJson({ ok: true, members }, 200, requestId);
  } catch (error) {
    return projectApiError(error, requestId);
  }
}
