// Единое сохранение поканального профиля Авроры.
// Бриф, редакционный стандарт и режим автопилота меняются одной транзакцией:
// пользователь либо получает целиком новую конфигурацию, либо остаётся на прежней.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { briefComplete, normalizeBrief } from "@/lib/brief";
import { ensureSettings, loadBrief, resolveChannel } from "@/lib/autopilot";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import type { AutopilotSettings } from "@/lib/autopilot";
import { DEFAULT_AUTOPILOT_ENGINE } from "@/lib/autopilot-config.mjs";
import {
  ProjectAccessError,
  requireProjectPermission,
  requireSelectedProjectPermission,
} from "@/lib/project-permissions";

export const runtime = "nodejs";

type SettingsBody = {
  channelId?: unknown;
  brief?: unknown;
  settings?: {
    enabled?: unknown;
    mode?: unknown;
    post_frequency?: unknown;
  };
};

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const membership = await requireSelectedProjectPermission(getPool(), user.id, "project.read");
    const scope = { actorUserId: user.id, projectId: membership.projectId };
    const channelId = await resolveChannel(
      scope,
      Number(req.nextUrl.searchParams.get("channel")) || null,
    );
    if (!channelId) {
      return NextResponse.json({ error: "no_channel" }, { status: 422 });
    }
    const [brief, settings] = await Promise.all([
      loadBrief(scope, channelId),
      ensureSettings(scope, channelId),
    ]);
    return NextResponse.json({ channelId, brief, settings });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/settings/channel] GET", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: SettingsBody;
  try {
    body = (await readJsonBodyValue(req)) as SettingsBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  if (!body.brief || typeof body.brief !== "object" || Array.isArray(body.brief)) {
    return NextResponse.json({ ok: false, error: "bad_brief" }, { status: 422 });
  }
  if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) {
    return NextResponse.json({ ok: false, error: "bad_settings" }, { status: 422 });
  }

  const pool = getPool();
  let channelId: number | null;
  let projectId: number;
  try {
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.edit");
    await requireProjectPermission(pool, user.id, membership.projectId, "content.publish");
    projectId = membership.projectId;
    channelId = await resolveChannel(
      { actorUserId: user.id, projectId },
      Number(body.channelId) || null,
    );
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/settings/channel] resolve", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

  const brief = normalizeBrief({ ...body.brief, ready: true });
  if (!briefComplete(brief)) {
    return NextResponse.json({ ok: false, error: "incomplete" }, { status: 422 });
  }

  const postFrequency = 7;
  const enabled = typeof body.settings.enabled === "boolean" ? body.settings.enabled : null;
  const mode = body.settings.mode === "confirm" || body.settings.mode === "full"
    ? body.settings.mode
    : null;

  if (enabled == null || mode == null) {
    return NextResponse.json({ ok: false, error: "bad_settings" }, { status: 422 });
  }

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    console.error("[/api/settings/channel] connect", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  try {
    await client.query("begin");
    // This endpoint changes both the editorial brief and publication automation.
    // Recheck both capabilities in the write transaction so a stale role decision
    // cannot authorize either half of the combined mutation.
    await requireProjectPermission(client, user.id, projectId, "content.edit");
    await requireProjectPermission(client, user.id, projectId, "content.publish");
    await client.query(
      `insert into autopilot_settings (project_id, user_id, channel_id, generation_engine)
       values ($1, $2, $3, $4)
       on conflict do nothing`,
      [projectId, user.id, channelId, DEFAULT_AUTOPILOT_ENGINE],
    );
    const current = await client.query<AutopilotSettings>(
      `select enabled, mode, post_frequency, approvals_streak, generation_engine,
              planning_months, planning_weeks, news_sources, quick_settings
         from autopilot_settings
        where project_id = $1 and channel_id = $2
        for update`,
      [projectId, channelId],
    );
    const previous = current.rows[0];
    if (!previous) throw new Error("settings_missing");

    if (mode === "full" && previous.mode !== "full" && previous.approvals_streak < 2) {
      await client.query("rollback");
      return NextResponse.json({ ok: false, error: "streak_required" }, { status: 422 });
    }

    await client.query(
      `insert into content_brief
         (project_id, user_id, channel_id, niche, audience, rubrics, formats, author_role, goal, cta, taboo, profile_answers, quality, ready, source, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true, $14, now())
       on conflict (project_id, channel_id) do update
         set niche = excluded.niche,
             audience = excluded.audience,
             rubrics = excluded.rubrics,
             formats = excluded.formats,
             author_role = excluded.author_role,
             goal = excluded.goal,
             cta = excluded.cta,
             taboo = excluded.taboo,
             profile_answers = excluded.profile_answers,
             quality = excluded.quality,
             ready = true,
             source = excluded.source,
             updated_at = now()`,
      [
        projectId,
        user.id,
        channelId,
        brief.niche,
        brief.audience,
        brief.rubrics,
        brief.formats,
        brief.authorRole,
        brief.goal,
        brief.cta,
        brief.taboo,
        JSON.stringify(brief.profileAnswers),
        JSON.stringify(brief.quality),
        brief.source ?? "manual",
      ],
    );

    const updated = await client.query<AutopilotSettings>(
      `update autopilot_settings
          set enabled = $3,
              mode = $4,
              post_frequency = $5,
              updated_at = now()
        where project_id = $1 and channel_id = $2
        returning enabled, mode, post_frequency, approvals_streak, generation_engine,
                  planning_months, planning_weeks, news_sources, quick_settings`,
      [projectId, channelId, enabled, mode, postFrequency],
    );
    await client.query("commit");
    return NextResponse.json({ ok: true, channelId, brief, settings: updated.rows[0] });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    console.error("[/api/settings/channel] POST", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  } finally {
    client.release();
  }
}
