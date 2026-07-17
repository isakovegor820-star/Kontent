// Д.7 — действия над идеей: «в черновик» (drafted) или «скрыть» (dismissed).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const status =
    body.action === "dismiss" ? "dismissed" : body.action === "draft" ? "drafted" : null;
  if (!status) return NextResponse.json({ ok: false, error: "bad_action" }, { status: 422 });

  try {
    await getPool().query(`update content_ideas set status = $3 where id = $1 and user_id = $2`, [
      id,
      user.id,
      status,
    ]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/ideas/[id]]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
