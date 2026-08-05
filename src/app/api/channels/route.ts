// Д.3/Д.4 — список подключённых каналов пользователя (для интерфейса).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const rows = await getPool().query(
      `select id, network, title, handle, is_active
         from channels
        where user_id = $1 and is_active = true
        order by id`,
      [user.id],
    );
    return NextResponse.json({
      channels: rows.rows.map((channel) => ({
        ...channel,
        // `channels.id` — bigint, node-postgres отдаёт его строкой. Клиентский
        // контракт RealChannel использует number, поэтому нормализуем один раз здесь.
        id: Number(channel.id),
      })),
    });
  } catch (err) {
    console.error("[/api/channels]", { errorName: err instanceof Error ? err.name : "Error" });
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
