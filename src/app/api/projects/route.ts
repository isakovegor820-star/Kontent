import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { createProject, listProjectsForUser } from "@/lib/project-team";
import { projectApiError, projectJson, readObjectBody } from "./_shared";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    return projectJson({ ok: true, projects: await listProjectsForUser(getPool(), user.id) }, 200, requestId);
  } catch (error) {
    return projectApiError(error, requestId);
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return projectJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const body = await readObjectBody(req);
  if (!body) return projectJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const project = await createProject({
      pool: getPool(),
      actorUserId: user.id,
      name: body.name,
      timezone: body.timezone,
      idempotencyKey: req.headers.get("idempotency-key"),
      requestId,
    });
    return projectJson({ ok: true, project }, 201, requestId);
  } catch (error) {
    return projectApiError(error, requestId);
  }
}
