// Д.9 — бриф контента: что за канал. Без него автопилот не запускается.
// GET отдаёт бриф + список рубрик для интерфейса, POST сохраняет.
// ready ставит только пользователь, подтвердив бриф глазами (честность).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { RUBRICS, briefComplete, normalizeBrief } from "@/lib/brief";
import { ensureSettings, loadBrief, resolveChannel } from "@/lib/autopilot";
import { selectAutopilotNewsSources } from "@/lib/autopilot-source-selection";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    const scope = { actorUserId: user.id, projectId: membership.projectId };
    const channelId = await resolveChannel(scope, Number(req.nextUrl.searchParams.get("channel")) || null);
    if (!channelId) return NextResponse.json({ brief: null, rubrics: RUBRICS });
    return NextResponse.json({ brief: await loadBrief(scope, channelId), rubrics: RUBRICS, channelId });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/autopilot/brief] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.edit");
    const scope = { actorUserId: user.id, projectId: membership.projectId };
    // Бриф описывает КАНАЛ, а не человека: участники одного проекта работают с общей строкой.
    const channelId = await resolveChannel(
      scope,
      Number((body as { channelId?: unknown })?.channelId) || null,
    );
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const b = normalizeBrief(body);
    // Подтвердить можно только заполненный бриф — иначе ИИ снова начнёт выдумывать.
    if (b.ready && !briefComplete(b)) {
      return NextResponse.json({ ok: false, error: "incomplete" }, { status: 422 });
    }

    await pool.query(
      `insert into content_brief
         (project_id, user_id, channel_id, niche, audience, rubrics, formats, author_role,
          goal, cta, taboo, profile_answers, quality, ready, source, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
       on conflict (project_id, channel_id) do update
            set niche = excluded.niche, audience = excluded.audience, rubrics = excluded.rubrics,
                formats = excluded.formats, author_role = excluded.author_role,
                goal = excluded.goal, cta = excluded.cta, taboo = excluded.taboo,
                profile_answers = excluded.profile_answers, quality = excluded.quality, ready = excluded.ready,
                source = excluded.source, updated_at = now()`,
      [
        membership.projectId,
        user.id,
        channelId,
        b.niche,
        b.audience,
        b.rubrics,
        b.formats,
        b.authorRole,
        b.goal,
        b.cta,
        b.taboo,
        JSON.stringify(b.profileAnswers),
        JSON.stringify(b.quality),
        b.ready,
        b.source,
      ],
    );
    if (b.ready) {
      // A weekly build may run before the user ever presses “Собрать”. Persist the curated
      // perimeter at brief confirmation so unattended Autopilot still discovers news itself.
      await ensureSettings(scope, channelId);
      await pool.query(
        `update autopilot_settings
            set news_sources = $3::jsonb, updated_at = now()
          where project_id = $1 and channel_id = $2`,
        [membership.projectId, channelId, JSON.stringify(selectAutopilotNewsSources(b))],
      );
    }
    return NextResponse.json({ ok: true, brief: b });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/autopilot/brief] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
