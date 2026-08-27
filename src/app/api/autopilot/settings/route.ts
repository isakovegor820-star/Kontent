// Д.9 — обновить настройки автопилота (вкл/выкл, режим, частота).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { ensureSettings, loadBrief, resolveChannel } from "@/lib/autopilot";
import { briefComplete } from "@/lib/brief";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import type { AutopilotSettings } from "@/lib/autopilot";
import {
  AUTOPILOT_PLANNING_MONTHS,
  isAutopilotEngine,
  isAutopilotPlanningWeeks,
} from "@/lib/autopilot-config.mjs";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { selectAutopilotNewsSources } from "@/lib/autopilot-source-selection";
import { normalizeAutopilotQuickSettings } from "@/lib/autopilot-style.mjs";
import { getAutopilotQueue } from "@/lib/queue";
import { resumeAutopilotPartialPlan } from "@/lib/autopilot-weekly-queue.mjs";

export const runtime = "nodejs";

const MAX_SETTINGS_BODY_BYTES = 16 * 1024;
const SETTINGS_KEYS = new Set([
  "enabled",
  "mode",
  "post_frequency",
  "generation_engine",
  "planning_months",
  "planning_weeks",
  "quick_settings",
  "channelId",
]);

async function readSettingsBody(req: NextRequest) {
  if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return null;
  }
  try {
    const bytes = await readRequestBodyLimited(req.body, MAX_SETTINGS_BODY_BYTES);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const body = parsed as Record<string, unknown>;
    return Object.keys(body).every((key) => SETTINGS_KEYS.has(key)) ? body : null;
  } catch (error) {
    if (error instanceof BoundedBodyError || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  try {
    const user = await getSessionUser(req);
    if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    const rate = await checkRateLimit(`autopilot-settings:user:${user.id}`, 120, 3_600, {
      failureMode: "closed",
    });
    if (!rate.allowed) return rateLimitResponse(rate);

    const body = await readSettingsBody(req);
    if (!body) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    const pool = getPool();
    const permission = typeof body.enabled === "boolean" || body.mode != null
      ? "content.publish"
      : "content.edit";
    const membership = await requireSelectedProjectPermission(pool, user.id, permission);
    const scope = { actorUserId: user.id, projectId: membership.projectId };

    // Настройки — у каждого канала свои: частота, режим и вкл/выкл на канале с новостями
    // и на канале с юридической аналитикой не обязаны совпадать.
    const channelId = await resolveChannel(scope, Number(body.channelId) || null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const cur = await ensureSettings(scope, channelId);
    const enabled = typeof body.enabled === "boolean" ? body.enabled : null;
    const mode = body.mode === "confirm" || body.mode === "full" ? body.mode : null;

  // Включать автопилот можно только с готовым брифом — иначе он начнёт писать наугад (ТЗ Д.9).
  // Проверяем на СЕРВЕРЕ: гейт в интерфейсе обходится прямым запросом.
    let selectedNewsSources: string | null = null;
    if (enabled === true && !cur.enabled) {
      const brief = await loadBrief(scope, channelId);
      if (!brief.ready || !briefComplete(brief)) {
        return NextResponse.json({ ok: false, error: "no_brief" }, { status: 422 });
      }
      selectedNewsSources = JSON.stringify(selectAutopilotNewsSources(brief));
    }

  // Полный режим (публикация без подтверждения) — только после 2 недель одобрений без правок.
  // Проверяем на СЕРВЕРЕ, а не только в UI, иначе гейт обходится прямым запросом (ревью).
    if (mode === "full" && cur.mode !== "full" && cur.approvals_streak < 2) {
      return NextResponse.json({ ok: false, error: "streak_required" }, { status: 422 });
    }

    const requestedFrequency = Number(body.post_frequency);
    const freq = body.post_frequency == null
      ? null
      : Number.isSafeInteger(requestedFrequency) && requestedFrequency >= 1 && requestedFrequency <= 7
        ? requestedFrequency
        : undefined;
    const quickSettings = body.quick_settings == null
      ? null
      : normalizeAutopilotQuickSettings(body.quick_settings);
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
    if (freq === undefined || generationEngine === undefined || planningWeeks === undefined) {
      return NextResponse.json({ ok: false, error: "bad_generation_settings" }, { status: 422 });
    }

    const updated = await pool.query<AutopilotSettings>(
      `update autopilot_settings
          set enabled = coalesce($3, enabled),
              mode = coalesce($4, mode),
              post_frequency = coalesce($5, post_frequency),
              generation_engine = coalesce($6, generation_engine),
              planning_months = coalesce($7, planning_months),
              planning_weeks = coalesce($8, planning_weeks),
              news_sources = coalesce($9::jsonb, news_sources),
              quick_settings = coalesce($10::jsonb, quick_settings),
              updated_at = now()
        where project_id = $1 and channel_id = $2
        returning enabled, mode, post_frequency, approvals_streak, generation_engine,
                  planning_months, planning_weeks, quick_settings`,
      [
        membership.projectId,
        channelId,
        enabled,
        mode,
        freq,
        generationEngine,
        planningMonths,
        planningWeeks,
        selectedNewsSources,
        quickSettings == null ? null : JSON.stringify(quickSettings),
      ],
    );
    if (!updated.rows[0]) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    let resumedPartialPlan = false;
    if (enabled === true) {
      const resumed = await resumeAutopilotPartialPlan({
        pool,
        queue: getAutopilotQueue(),
        projectId: membership.projectId,
        userId: user.id,
        channelId,
      }).catch((error) => {
        // The settings change is already durable. The worker's 30-second reconciler will
        // retry the same partial plan, so a temporary Redis outage must not roll back enable.
        console.warn("[/api/autopilot/settings] partial resume pending", {
          projectId: membership.projectId,
          channelId,
          errorName: error instanceof Error ? error.name : "Error",
        });
        return null;
      });
      resumedPartialPlan = resumed?.status === "queued";
    } else if (enabled === false) {
      await pool.query(
        `update autopilot_plan
            set build_report = coalesce(build_report, '{}'::jsonb)
                  || '{"recoveryState":"paused","nextRetryAt":null}'::jsonb,
                build_activity_at = now(), revision = revision + 1
          where project_id = $1 and channel_id = $2 and status = 'partial'
            and build_report ? 'autoRecovery'`,
        [membership.projectId, channelId],
      ).catch((error) => {
        // The continuation claim also checks settings.enabled and will refuse to run. This
        // write only makes the paused state visible immediately if PostgreSQL was transiently
        // unavailable after the authoritative settings update.
        console.warn("[/api/autopilot/settings] partial pause display pending", {
          projectId: membership.projectId,
          channelId,
          errorName: error instanceof Error ? error.name : "Error",
        });
      });
    }
    return NextResponse.json({
      ok: true,
      settings: updated.rows[0],
      resumedPartialPlan,
    });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/autopilot/settings]", {
      errorName: err instanceof Error ? err.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}
