// Универсальное добавление источника конкурента. Сеть выбирает адаптер воркера, а не
// отдельный API-роут: у Telegram/Instagram одинаковые лимит, жизненный цикл и карточка.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import {
  MAX_COMPETITORS,
  isCompetitorNetwork,
  parseCompetitorSource,
} from "@/lib/competitors";
import { resolveChannel } from "@/lib/autopilot";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { url?: unknown; handle?: unknown; channelId?: unknown; network?: unknown; title?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const network = body.network ?? "tg";
  if (!isCompetitorNetwork(network)) {
    return NextResponse.json({ ok: false, error: "unsupported_network" }, { status: 422 });
  }
  const { handle, error } = parseCompetitorSource(network, String(body.url ?? body.handle ?? ""));
  if (error || !handle) return NextResponse.json({ ok: false, error: error ?? "bad" }, { status: 422 });
  // Старый Telegram-онбординг присылает только handle. Оставляем его рабочим, но новая
  // форма всегда передаёт явное человеческое название.
  const customTitle = body.title === undefined
    ? `@${handle}`
    : String(body.title).trim().replace(/\s+/g, " ");
  if (customTitle.length < 2 || customTitle.length > 120) {
    return NextResponse.json({ ok: false, error: "bad_title" }, { status: 422 });
  }

  try {
    const pool = getPool();
    // Конкурент — сосед КАНАЛА. Лимит и дубликаты тоже считаем по каналу: 20 соседей у канала
    // про банкротство не должны съедать место у канала про ИИ в праве.
    const channelId = await resolveChannel(user.id, Number(body.channelId) || null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const cnt = (
      await pool.query<{ n: number }>(
        `select count(*)::int as n from competitors where channel_id = $1`,
        [channelId],
      )
    ).rows[0].n;
    if (cnt >= MAX_COMPETITORS) {
      return NextResponse.json({ ok: false, error: "limit", limit: MAX_COMPETITORS }, { status: 409 });
    }

    const dup = await pool.query(
      `select id from competitors where channel_id = $1 and network = $2 and handle = $3`,
      [channelId, network, handle],
    );
    if (dup.rowCount) return NextResponse.json({ ok: false, error: "duplicate" }, { status: 409 });

    const ins = await pool.query<{ id: number }>(
      `insert into competitors
         (user_id, channel_id, network, handle, custom_title, status, connection_method, is_active)
       values ($1, $2, $3, $4, $5, 'pending', $6, true) returning id`,
      [
        user.id,
        channelId,
        network,
        handle,
        customTitle,
        network === "instagram" ? "instagram_business_discovery" : "telegram_public_web",
      ],
    );
    const id = ins.rows[0].id;

    // Первичный сбор сразу — досье готово за секунды. attempts на случай сетевого сбоя.
    try {
      await getStatsQueue().add(
        "competitor",
        { id },
        { removeOnComplete: true, attempts: 2, backoff: { type: "fixed", delay: 15000 } },
      );
    } catch (error) {
      // Не оставляем вечный «pending», который затем блокирует повторное добавление.
      await pool.query(`delete from competitors where id = $1 and status = 'pending'`, [id]);
      throw error;
    }

    return NextResponse.json({ ok: true, id, handle, network });
  } catch (err) {
    console.error("[/api/competitors/add]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
