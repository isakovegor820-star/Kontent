// Д.6 — добавить конкурента по ссылке. Проверяем лимит 20, дубликат, приватные ссылки.
// Запускаем немедленный сбор досье через воркер (та же очередь stats).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { MAX_COMPETITORS, parseHandle } from "@/lib/competitors";
import { resolveChannel } from "@/lib/autopilot";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { url?: unknown; handle?: unknown; channelId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const { handle, error } = parseHandle(String(body.url ?? body.handle ?? ""));
  if (error || !handle) return NextResponse.json({ ok: false, error: error ?? "bad" }, { status: 422 });

  try {
    const pool = getPool();
    // Конкурент — сосед КАНАЛА. Лимит и дубликаты тоже считаем по каналу: 20 соседей у канала
    // про банкротство не должны съедать место у канала про ИИ в праве.
    const channelId = await resolveChannel(user.id, Number(body.channelId) || null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const cnt = (
      await pool.query<{ n: number }>(
        `select count(*)::int as n from competitors where channel_id = $1 and network = 'tg'`,
        [channelId],
      )
    ).rows[0].n;
    if (cnt >= MAX_COMPETITORS) {
      return NextResponse.json({ ok: false, error: "limit", limit: MAX_COMPETITORS }, { status: 409 });
    }

    const dup = await pool.query(
      `select id from competitors where channel_id = $1 and network = 'tg' and handle = $2`,
      [channelId, handle],
    );
    if (dup.rowCount) return NextResponse.json({ ok: false, error: "duplicate" }, { status: 409 });

    const ins = await pool.query<{ id: number }>(
      `insert into competitors (user_id, channel_id, network, handle, status)
       values ($1, $2, 'tg', $3, 'pending') returning id`,
      [user.id, channelId, handle],
    );
    const id = ins.rows[0].id;

    // Первичный сбор сразу — досье готово за секунды. attempts на случай сетевого сбоя.
    await getStatsQueue().add(
      "competitor",
      { id },
      { removeOnComplete: true, attempts: 2, backoff: { type: "fixed", delay: 15000 } },
    );

    return NextResponse.json({ ok: true, id, handle });
  } catch (err) {
    console.error("[/api/competitors/add]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
