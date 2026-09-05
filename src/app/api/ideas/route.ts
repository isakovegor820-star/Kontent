// Д.7 — лента идей для публикаций из залётов конкурентов. Детекция реальная (медиана × 5),
// сценарий пишет выбранный ИИ. Незавершённые записи остаются в диагностике реестра,
// а этот публичный список отдаёт только готовые идеи с заполненным содержанием.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { ProjectAccessError } from "@/lib/project-permissions";
import { withSelectedProjectPermission } from "@/lib/selected-project-transaction";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    return await withSelectedProjectPermission(getPool(), user.id, "project.read", async (pool, membership) => {
    const rows = (
      await pool.query(
        `select i.id, i.topic, i.hook, i.structure, i.why_it_worked, i.format,
                i.hit_ratio, i.status, i.ai_status, i.created_at,
                c.handle as competitor_handle, c.title as competitor_title,
                cp.tg_msg_id, cp.views as source_views, cp.text as source_text
           from content_ideas i
           join competitors c on c.id = i.competitor_id
           join channels channel on channel.id = c.channel_id and channel.project_id = $2
           left join competitor_posts cp on cp.id = i.source_post_id
          where i.user_id = $1 and i.status = 'new' and i.ai_status = 'ready'
          order by i.hit_ratio desc nulls last, i.created_at desc`,
        [user.id, membership.projectId],
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
    });
  } catch (err) {
    if (err instanceof ProjectAccessError) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    console.error("[/api/ideas]", err);
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
