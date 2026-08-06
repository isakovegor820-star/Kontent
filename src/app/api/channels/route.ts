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
      `select id, network, title, handle,
              (is_active and status = 'active') as is_active,
              status, last_auth_error_code, last_auth_error_at
         from channels
        where user_id = $1 and status <> 'disconnected'
        order by id`,
      [user.id],
    );
    return NextResponse.json({
      channels: rows.rows.map((channel) => ({
        ...channel,
        // `channels.id` — bigint, node-postgres отдаёт его строкой. Клиентский
        // контракт RealChannel использует number, поэтому нормализуем один раз здесь.
        id: Number(channel.id),
        reconnect_required: ["needs_reconnect", "permission_lost", "revoked"].includes(channel.status),
      })),
    });
  } catch (err) {
    console.error("[/api/channels]", { errorName: err instanceof Error ? err.name : "Error" });
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
