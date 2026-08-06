// Д.9 — обновить настройки автопилота (вкл/выкл, режим, частота).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { ensureSettings, loadBrief, resolveChannel } from "@/lib/autopilot";
import { MAX_WEEKLY_POSTS } from "@/lib/brief";
import { briefComplete } from "@/lib/brief";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import type { AutopilotSettings } from "@/lib/autopilot";
import {
  AUTOPILOT_PLANNING_MONTHS,
  isAutopilotEngine,
  isAutopilotPlanningWeeks,
} from "@/lib/autopilot-config.mjs";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  let body: {
    enabled?: unknown;
    mode?: unknown;
    post_frequency?: unknown;
    generation_engine?: unknown;
    planning_months?: unknown;
    planning_weeks?: unknown;
    channelId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  try {
    const user = await getSessionUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

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
    const generationEngine = body.generation_engine == null
      ? null
      : isAutopilotEngine(body.generation_engine)
        ? body.generation_engine
        : undefined;
    const requestedMonths = Number(body.planning_months);
    const requestedWeeks = Number(body.planning_weeks);
    const planningWeeks = body.planning_weeks != null
      ? isAutopilotPlanningWeeks(requestedWeeks) ? requestedWeeks : undefined
      : body.planning_months != null
        ? AUTOPILOT_PLANNING_MONTHS.includes(requestedMonths) ? requestedMonths * 4 : undefined
        : null;
    const planningMonths = planningWeeks == null
      ? null
      : Math.max(1, Math.min(3, Math.ceil(planningWeeks / 4)));
    if (generationEngine === undefined || planningWeeks === undefined) {
      return NextResponse.json({ ok: false, error: "bad_generation_settings" }, { status: 422 });
    }

    const updated = await getPool().query<AutopilotSettings>(
      `update autopilot_settings
          set enabled = coalesce($3, enabled),
              mode = coalesce($4, mode),
              post_frequency = coalesce($5, post_frequency),
              generation_engine = coalesce($6, generation_engine),
              planning_months = coalesce($7, planning_months),
              planning_weeks = coalesce($8, planning_weeks),
              updated_at = now()
        where user_id = $1 and channel_id = $2
        returning enabled, mode, post_frequency, approvals_streak, generation_engine,
                  planning_months, planning_weeks`,
      [user.id, channelId, enabled, mode, freq, generationEngine, planningMonths, planningWeeks],
    );
    if (!updated.rows[0]) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, settings: updated.rows[0] });
  } catch (err) {
    console.error("[/api/autopilot/settings]", {
      errorName: err instanceof Error ? err.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}
