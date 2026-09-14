// Ручной запуск сбора RSS-лент: кнопка «Проверить сейчас» на экране RSS.
// Крон и так проверяет каждые 30 минут — здесь человеку даём контроль «прямо сейчас».
// jobId по юзеру: частые клики не плодят задачи, а сливаются в одну (паттерн /api/trends).

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { channelId?: unknown } = {};
  try {
    body = await readJsonBodyValue(req);
  } catch {
    // Старые клиенты могли отправлять пустой body — ниже используем все ленты.
  }
  const channelId = Number(body.channelId) || null;

  try {
    if (channelId) {
      const channel = await getPool().query(
        `select id from channels
          where id = $1 and user_id = $2 and is_active and network in ('tg', 'vk')`,
        [channelId, user.id],
      );
      if (!channel.rowCount) {
        return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
      }
    }
    await getStatsQueue().add(
      "rss-now",
      { userId: user.id, channelId },
      {
        jobId: `rss-now-${user.id}-${channelId ?? "all"}`,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 2,
        backoff: { type: "fixed", delay: 15000 },
      },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/rss/refresh] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
