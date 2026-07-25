// Мониторинг упоминаний: DELETE query по id.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const queryId = Number(id);
  if (!queryId) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  try {
    await getPool().query(
      `delete from mention_queries where id = $1 and user_id = $2`,
      [queryId, user.id],
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/mentions/[id]] DELETE", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
