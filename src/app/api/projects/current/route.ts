import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { getSelectedProjectContext, selectProjectForUser } from "@/lib/project-context";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { projectApiError, projectJson, readObjectBody } from "../_shared";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    return projectJson({ ok: true, project: await getSelectedProjectContext(getPool(), user.id) }, 200, requestId);
  } catch (error) {
    return projectApiError(error, requestId);
  }
}

export async function PUT(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return projectJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const body = await readObjectBody(req);
  const projectId = typeof body?.projectId === "number" ? body.projectId : Number.NaN;
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    return projectJson({ ok: false, error: "bad_project" }, 400, requestId);
  }
  try {
    const project = await selectProjectForUser(getPool(), user.id, projectId);
    return projectJson({ ok: true, project }, 200, requestId);
  } catch (error) {
    return projectApiError(error, requestId);
  }
}
