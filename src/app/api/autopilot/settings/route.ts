// Д.9 — обновить настройки автопилота (вкл/выкл, режим, частота).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { ensureSettings, loadBrief, resolveChannel } from "@/lib/autopilot";
import { MAX_WEEKLY_POSTS } from "@/lib/brief";
import { briefComplete } from "@/lib/brief";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { enabled?: unknown; mode?: unknown; post_frequency?: unknown; channelId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  // Настройки — у каждого канала свои: частота, режим и вкл/выкл на канале с новостями
  // и на канале с юридической аналитикой не обязаны совпадать.
  const channelId = await resolveChannel(user.id, Number(body.channelId) || null);
  if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

  const cur = await ensureSettings(user.id, channelId);
  const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
  const mode = body.mode === "confirm" || body.mode === "full" ? body.mode : null;

  // Включать автопилот можно только с готовым брифом — иначе он начнёт писать наугад (ТЗ Д.9).
  // Проверяем на СЕРВЕРЕ: гейт в интерфейсе обходится прямым запросом.
  if (enabled === true && !cur.enabled) {
    const brief = await loadBrief(user.id, channelId);
    if (!brief.ready || !briefComplete(brief)) {
      return NextResponse.json({ ok: false, error: "no_brief" }, { status: 422 });
    }
  }

  // Полный режим (публикация без подтверждения) — только после 2 недель одобрений без правок.
  // Проверяем на СЕРВЕРЕ, а не только в UI, иначе гейт обходится прямым запросом (ревью).
  if (mode === "full" && cur.mode !== "full" && cur.approvals_streak < 2) {
    return NextResponse.json({ ok: false, error: "streak_required" }, { status: 422 });
  }

  // Частоту выбирает человек, а не мы. Прежний потолок 7 был не про вкус — он прятал баг
  // планировщика: тот ставил пост i на день i+1, и при 14 план разъезжался на две недели
  // вместо «14 постов за неделю». Планировщик починен (weekSlots), потолок снят.
  // Оставшийся предел — физический: ИИ пишет посты по одному, до 90с на пост.
  const freq =
    Number.isFinite(Number(body.post_frequency)) && Number(body.post_frequency) > 0
      ? Math.min(MAX_WEEKLY_POSTS, Math.max(1, Math.round(Number(body.post_frequency))))
      : null;

  try {
    await getPool().query(
      `update autopilot_settings
          set enabled = coalesce($3, enabled),
              mode = coalesce($4, mode),
              post_frequency = coalesce($5, post_frequency),
              updated_at = now()
        where user_id = $1 and channel_id = $2`,
      [user.id, channelId, enabled, mode, freq],
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/autopilot/settings]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
