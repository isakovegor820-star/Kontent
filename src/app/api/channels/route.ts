// Д.3/Д.4 — список подключённых каналов пользователя (для интерфейса).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ channels: [] });

  try {
    const rows = await getPool().query(
      `select id, network, title, handle, is_active
         from channels
        where user_id = $1 and is_active = true
        order by id`,
      [user.id],
    );
    return NextResponse.json({ channels: rows.rows });
  } catch (err) {
    console.error("[/api/channels]", err);
    return NextResponse.json({ channels: [] });
  }
}
