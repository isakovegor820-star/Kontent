import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { withProjectRoute } from "@/lib/project-route";
// Д.7 — действия над идеей: «в черновик» (drafted) или «скрыть» (dismissed).

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

async function handlePATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    const membership = await requireSelectedProjectPermission(getPool(), user.id, "content.edit");
    await getPool().query(`update content_ideas set status = $3 where id = $1 and exists (select 1 from competitors competitor join channels channel on channel.id = competitor.channel_id where competitor.id = content_ideas.competitor_id and channel.project_id = $2)`, [
      id,
      membership.projectId,
      status,
    ]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ProjectAccessError) return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    console.error("[/api/ideas/[id]]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export const PATCH = withProjectRoute(handlePATCH);
