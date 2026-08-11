import { NextRequest, NextResponse } from "next/server";

import { getEditorialSnapshotForUser } from "@/lib/editorial-approval";
import { ProjectAccessError } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Context) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  }
  try {
    const editorial = await getEditorialSnapshotForUser(user.id, id);
    if (!editorial) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, editorial });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }
    console.error("[/api/drafts/:id/editorial GET]", error);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
