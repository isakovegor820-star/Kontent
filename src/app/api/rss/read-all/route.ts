import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    const readAt = new Date();
    const result = await pool.query(
      `insert into legal_opportunity_reads (user_id, project_id, rss_item_id, read_at)
       select $1, $2, item.id, $3
         from rss_items item
         join rss_feeds feed on feed.id = item.feed_id
         join channels channel on channel.id = feed.channel_id
        where feed.user_id = $1
          and channel.project_id = $2
          and feed.source_kind = 'legal_opportunity'
          and feed.is_active = true
          and item.skip_reason is distinct from 'irrelevant'
          and item.skip_reason is distinct from 'paused'
       on conflict (user_id, project_id, rss_item_id) do nothing
       returning rss_item_id`,
      [user.id, membership.projectId, readAt],
    );

    return NextResponse.json({
      ok: true,
      projectId: membership.projectId,
      markedCount: Math.max(0, Number(result.rowCount ?? result.rows.length) || 0),
      unreadCount: 0,
      readAt: readAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/rss/read-all] POST", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
