// Журнал RSS-записей: что пришло из лент и что с этим стало (пост создан / лимит / в работе).
// Без этого экрана репостер — чёрный ящик: человек добавил ленту и не видит, работает ли она.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { unreadLegalOpportunityCount } from "@/lib/legal-opportunity-unread";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rawChannelId = req.nextUrl.searchParams.get("channelId");
  const channelId = rawChannelId === null ? null : Number(rawChannelId);
  if (channelId !== null && (!Number.isSafeInteger(channelId) || channelId <= 0)) {
    return NextResponse.json({ error: "bad_channel" }, { status: 400 });
  }
  const summary = req.nextUrl.searchParams.get("summary");
  if (summary !== null && summary !== "unread") {
    return NextResponse.json({ error: "bad_summary" }, { status: 400 });
  }

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    const query = summary === "unread"
      ? `select i.id, i.feed_id, i.title, i.summary, i.status, i.skip_reason,
                i.post_id, f.title as feed_title, f.channel_id,
                opportunity.state as opportunity_state, reading.read_at
           from rss_items i
           join rss_feeds f on f.id = i.feed_id
           join channels c on c.id = f.channel_id and c.user_id = f.user_id
           left join legal_opportunity_states opportunity
             on opportunity.rss_item_id = i.id and opportunity.user_id = $1
           left join legal_opportunity_reads reading
             on reading.rss_item_id = i.id
            and reading.user_id = $1
            and reading.project_id = $2
          where f.user_id = $1
            and c.project_id = $2
            and f.source_kind = 'legal_opportunity'
            and f.is_active = true
            and ($3::bigint is null or f.channel_id = $3)`
      : `with ranked_items as (
           select i.id, i.feed_id, i.title, i.summary, i.link, i.published_at, i.status, i.skip_reason,
                  i.post_id, i.fetched_at,
                  f.title as feed_title, f.url as feed_url, f.channel_id,
                  c.title as channel_title, p.status as post_status,
                  opportunity.state as opportunity_state,
                  reading.read_at,
                  row_number() over (
                    partition by i.feed_id
                    order by coalesce(i.published_at, i.fetched_at) desc, i.id desc
                  ) as feed_rank
             from rss_items i
             join rss_feeds f on f.id = i.feed_id
             join channels c on c.id = f.channel_id and c.user_id = f.user_id
             left join posts p on p.id = i.post_id
             left join legal_opportunity_states opportunity
               on opportunity.rss_item_id = i.id and opportunity.user_id = $1
             left join legal_opportunity_reads reading
               on reading.rss_item_id = i.id
              and reading.user_id = $1
              and reading.project_id = $2
            where f.user_id = $1
              and c.project_id = $2
              and f.source_kind = 'legal_opportunity'
              and f.is_active = true
              and ($3::bigint is null or f.channel_id = $3)
         )
         select id, feed_id, title, summary, link, published_at, status, skip_reason,
                post_id, fetched_at, feed_title, feed_url, channel_id, channel_title,
                post_status, opportunity_state, read_at
           from ranked_items
          where feed_rank <= 6
          order by coalesce(published_at, fetched_at) desc, id desc
          limit 60`;
    const r = await pool.query(
      query,
      [user.id, membership.projectId, channelId],
    );
    const items = r.rows.map((item) => ({
      ...item,
      id: Number(item.id),
      feed_id: Number(item.feed_id),
      channel_id: Number(item.channel_id),
      post_id: item.post_id == null ? null : Number(item.post_id),
    }));
    const unreadCount = unreadLegalOpportunityCount(items);
    if (summary === "unread") {
      return NextResponse.json({ projectId: membership.projectId, unreadCount });
    }
    return NextResponse.json({
      projectId: membership.projectId,
      unreadCount,
      items,
    });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/rss/items] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}
