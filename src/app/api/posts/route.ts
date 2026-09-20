// Д.3/Д.4 — список реальных постов пользователя (для календаря).

import { NextRequest, NextResponse } from "next/server";
import { withSelectedProjectPermission } from "@/lib/selected-project-transaction";
import { getPool } from "@/lib/db";
import { ProjectAccessError } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";

import { parsePostsQuery, postsCursor, PostsQueryError } from "@/lib/posts-pagination";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const pool = getPool();
    return await withSelectedProjectPermission(pool, user.id, "project.read", async (pool, membership) => {
    const { from, to, limit, cursor, id } = parsePostsQuery(req.nextUrl.searchParams, membership.projectId);
    const rows = await pool.query(
      `select calendar_page.*, snapshot.calendar_version::text as calendar_version
         from projects snapshot
         left join lateral (
       select p.id, p.user_id as author_user_id,
              to_char(p.scheduled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at,
              coalesce(nullif(btrim(post_author.name), ''), 'Участник ' || p.user_id::text) as author_name,
              p.text, p.media, p.scheduled_at, p.status, p.tg_message_id, p.vk_post_id,
              p.attempts, p.last_error, p.published_at, p.created_at,
              p.external_message_id, p.verification_state,
              p.last_verification_attempt_at, p.last_verified_at,
              p.verification_error_code, p.verification_error_reason,
              p.publication_origin, p.next_attempt_at, p.quarantined_at,
              p.quarantine_reason, p.schedule_revision,
              coalesce(p.scheduled_timezone, operation.timezone, 'UTC') as scheduled_timezone,
              coalesce(p.scheduled_offset, operation.schedule_offset) as scheduled_offset,
              coalesce(p.scheduled_disambiguation, operation.schedule_disambiguation, 'reject')
                as scheduled_disambiguation,
              p.publication_operation_id, operation.draft_id as publication_draft_id,
              operation.status as publication_operation_status,
              operation.schedule_revision as operation_schedule_revision,
              p.channel_id, c.network, c.title as channel_title, c.handle, c.vk_group_id,
              coalesce(parts.items, '[]'::jsonb) as publication_parts
         from (
           select page.* from posts page
        where page.project_id = $1
          and exists (select 1 from channels scoped where scoped.id = page.channel_id and scoped.project_id = page.project_id)
          and ($7::bigint is null or page.id = $7)
          and ($2::timestamptz is null or page.scheduled_at >= $2::timestamptz)
          and ($3::timestamptz is null or page.scheduled_at < $3::timestamptz)
          and ($4::bigint is null or
            ($5::timestamptz is null and page.scheduled_at is null and page.id > $4) or
            ($5::timestamptz is not null and (page.scheduled_at > $5::timestamptz or page.scheduled_at is null
              or (page.scheduled_at = $5::timestamptz and page.id > $4))))
        order by page.scheduled_at nulls last, page.id
           limit $6
         ) p
         join users post_author on post_author.id = p.user_id
         join channels c on c.id = p.channel_id and c.project_id = p.project_id
         left join publication_operations operation
           on operation.id = p.publication_operation_id and operation.project_id = p.project_id
         left join lateral (
           select jsonb_agg(jsonb_build_object(
                    'partIndex', pp.part_index,
                    'type', pp.part_type,
                    'externalMessageId', pp.external_message_id,
                    'sendStatus', pp.send_status,
                    'verificationState', pp.verification_state,
                    'lastErrorCode', pp.last_error_code
                  ) order by pp.part_index) as items
             from publication_parts pp where pp.post_id = p.id
         ) parts on true
        order by p.scheduled_at nulls last, p.id
        limit $6
         ) calendar_page on true
        where snapshot.id = $1
        order by calendar_page.scheduled_at nulls last, calendar_page.id`,
      [membership.projectId, from, to, cursor?.id ?? null, cursor?.at ?? null, limit + 1, id],
    );
    const snapshotVersion = rows.rows[0]?.calendar_version;
    if (typeof snapshotVersion !== "string" || !/^[1-9]\d*$/u.test(snapshotVersion)) throw new Error("posts_snapshot_unavailable");
    if (cursor && cursor.snapshotVersion !== snapshotVersion) {
      return NextResponse.json({ error: "posts_snapshot_changed" }, { status: 409, headers: { "cache-control": "no-store" } });
    }
    const records = rows.rows.filter((row) => row.id !== null);
    const posts = records.slice(0, limit);
    const hasMore = records.length > limit;
    const last = posts.at(-1);
    return NextResponse.json({
      projectId: membership.projectId,
      pageInfo: { snapshotVersion, hasMore, nextCursor: hasMore && last ? postsCursor({snapshotVersion, projectId: membership.projectId, from, to, at: last.cursor_at, id: Number(last.id)}) : null, from, to },
      posts: posts.map((post) => ({
        ...post,
        cursor_at: undefined,
        calendar_version: undefined,
        // PostgreSQL `bigint` arrives through node-postgres as a string. The client-side
        // RealPost contract uses numbers and compares channel ids with RealChannel ids, so
        // normalize every numeric identity once at the API boundary.
        id: Number(post.id),
        author_user_id: Number(post.author_user_id),
        tg_message_id: post.tg_message_id == null ? null : Number(post.tg_message_id),
        vk_post_id: post.vk_post_id == null ? null : Number(post.vk_post_id),
        channel_id: post.channel_id == null ? null : Number(post.channel_id),
        vk_group_id: post.vk_group_id == null ? null : Number(post.vk_group_id),
        publication_operation_id: post.publication_operation_id == null
          ? null
          : Number(post.publication_operation_id),
        publication_draft_id: post.publication_draft_id == null
          ? null
          : Number(post.publication_draft_id),
      })),
    });
    });
  } catch (err) {
    if (err instanceof PostsQueryError) return NextResponse.json({error: err.message}, {status: 400});
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/posts]", { errorName: err instanceof Error ? err.name : "Error" });
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
