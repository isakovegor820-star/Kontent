import { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { requireProjectPermission } from "@/lib/project-permissions";
import { withProjectRoute } from "@/lib/project-route";
import { selectedProjectDto } from "@/lib/project-dto";
import { projectApiError, projectJson } from "../_shared";

export const runtime = "nodejs";
async function handleGET(req: NextRequest, context: { params: Promise<{ projectId: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return projectJson({ ok: false, error: "unauthorized" }, 401);
  const projectId = Number((await context.params).projectId);
  try {
    const pool = getPool();
    const membership = await requireProjectPermission(pool, user.id, projectId, "project.read");
    const row = (await pool.query<{ name: string; timezone: string; personal: boolean }>(
      `select name, timezone, (personal_owner_user_id = $2) as personal
         from projects where id = $1 and is_archived = false`, [projectId, user.id],
    )).rows[0];
    if (!row) return projectJson({ ok: false, error: "not_found" }, 404);
    return projectJson({ ok: true, project: selectedProjectDto({
      projectId, name: row.name, timezone: row.timezone, personal: row.personal === true,
      role: membership.role, version: membership.version,
    }) });
  } catch (error) { return projectApiError(error, crypto.randomUUID()); }
}
export const GET = withProjectRoute(handleGET, { projectInPath: true });
