// Д.7 — действия над идеей: «в черновик» (drafted) или «скрыть» (dismissed).

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { ProjectAccessError } from "@/lib/project-permissions";
import { withSelectedProjectPermission } from "@/lib/selected-project-transaction";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  let body: { action?: unknown };
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const status =
    body.action === "dismiss" ? "dismissed" : body.action === "draft" ? "drafted" : null;
  if (!status) return NextResponse.json({ ok: false, error: "bad_action" }, { status: 422 });

  try {
    return await withSelectedProjectPermission(getPool(), user.id, "content.edit", async (pool, membership) => {
    const updated = await pool.query(`update content_ideas idea set status = $3
      from competitors competitor join channels channel on channel.id = competitor.channel_id
      where idea.id = $1 and idea.user_id = $2 and idea.competitor_id = competitor.id and channel.project_id = $4`, [
      id,
      user.id,
      status,
      membership.projectId,
    ]);
    if (!updated.rowCount) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
    });
  } catch (err) {
    if (err instanceof ProjectAccessError) return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    console.error("[/api/ideas/[id]]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
