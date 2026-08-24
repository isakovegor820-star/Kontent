// Д.3/Д.4 — список реальных постов пользователя (для календаря).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    const rows = await pool.query(
      `select p.id, p.user_id as author_user_id,
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
              p.publication_operation_id, operation.status as publication_operation_status,
              operation.schedule_revision as operation_schedule_revision,
              p.channel_id, c.network, c.title as channel_title, c.handle, c.vk_group_id,
              coalesce(parts.items, '[]'::jsonb) as publication_parts
         from posts p
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
        where p.project_id = $1
        order by p.scheduled_at nulls last, p.id desc
        limit 200`,
      [membership.projectId],
    );
    return NextResponse.json({
      posts: rows.rows.map((post) => ({
        ...post,
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
      })),
    });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/posts]", { errorName: err instanceof Error ? err.name : "Error" });
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
