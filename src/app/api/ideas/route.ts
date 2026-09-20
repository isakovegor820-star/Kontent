import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { withProjectRoute } from "@/lib/project-route";
// Д.7 — лента идей для публикаций из залётов конкурентов. Детекция реальная (медиана × 5),
// сценарий пишет выбранный ИИ. Незавершённые записи остаются в диагностике реестра,
// а этот публичный список отдаёт только готовые идеи с заполненным содержанием.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

async function handleGET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ideas: [] });

  try {
    const membership = await requireSelectedProjectPermission(getPool(), user.id, "project.read");
    const rows = (
      await getPool().query(
        `select i.id, i.topic, i.hook, i.structure, i.why_it_worked, i.format,
                i.hit_ratio, i.status, i.ai_status, i.created_at,
                c.handle as competitor_handle, c.title as competitor_title,
                cp.tg_msg_id, cp.views as source_views, cp.text as source_text
           from content_ideas i
           left join competitors c on c.id = i.competitor_id
           left join competitor_posts cp on cp.id = i.source_post_id
          where exists (select 1 from channels channel where channel.id = c.channel_id and channel.project_id = $1) and i.status = 'new' and i.ai_status = 'ready'
          order by i.hit_ratio desc nulls last, i.created_at desc`,
        [membership.projectId],
      )
    ).rows;

    const ideas = rows.map((r) => ({
      ...r,
      sourceLink:
        r.competitor_handle && r.tg_msg_id
          ? `https://t.me/${r.competitor_handle}/${r.tg_msg_id}`
          : null,
    }));
    return NextResponse.json({ ideas });
  } catch (err) {
    if (err instanceof ProjectAccessError) return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    console.error("[/api/ideas]", err);
    return NextResponse.json({ ideas: [] });
  }
}

export const GET = withProjectRoute(handleGET);
