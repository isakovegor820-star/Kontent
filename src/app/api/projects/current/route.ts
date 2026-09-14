import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getSelectedProjectContext, selectProjectForUser } from "@/lib/project-context";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { normalizeProjectName, normalizeProjectTimezone } from "@/lib/project-team";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { projectApiError, projectBodyFailure, projectJson, readProjectBody } from "../_shared";

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
  const rate = await checkRateLimit(`project:select:user:${user.id}`, 120, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await readProjectBody(req, ["projectId"]);
  if (!parsed.ok) return projectBodyFailure(parsed, requestId);
  const body = parsed.body;
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

export async function PATCH(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return projectJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`project:update:user:${user.id}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await readProjectBody(req, ["name", "timezone"]);
  if (!parsed.ok) return projectBodyFailure(parsed, requestId);
  try {
    const name = normalizeProjectName(parsed.body.name);
    const timezone = normalizeProjectTimezone(parsed.body.timezone);
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.manage");
    const updated = (
      await pool.query<{ id: string; name: string; timezone: string }>(
        `update projects set name = $2, timezone = $3, version = version + 1
          where id = $1 and is_archived = false
          returning id, name, timezone`,
        [membership.projectId, name, timezone],
      )
    ).rows[0];
    if (!updated) return projectJson({ ok: false, error: "bad_project" }, 404, requestId);
    return projectJson({ ok: true, project: { id: Number(updated.id), name: updated.name, timezone: updated.timezone } }, 200, requestId);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return projectJson({ ok: false, error: "access_denied" }, 403, requestId);
    }
    return projectApiError(error, requestId);
  }
}
