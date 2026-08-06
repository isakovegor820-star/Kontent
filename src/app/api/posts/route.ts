// Д.3/Д.4 — список реальных постов пользователя (для календаря).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const rows = await getPool().query(
      `select p.id, p.text, p.media, p.scheduled_at, p.status, p.tg_message_id, p.vk_post_id,
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
         join channels c on c.id = p.channel_id
         left join publication_operations operation on operation.id = p.publication_operation_id
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
        where p.user_id = $1
        order by p.scheduled_at nulls last, p.id desc
        limit 200`,
      [user.id],
    );
    return NextResponse.json({ posts: rows.rows });
  } catch (err) {
    console.error("[/api/posts]", { errorName: err instanceof Error ? err.name : "Error" });
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
