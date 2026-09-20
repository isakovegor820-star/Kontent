import type { Pool, PoolClient } from "pg";
import type { Post } from "./types";

export type TodayPublication = {
  key: string;
  draftId: number | null;
  draftVersion: number | null;
  text: string;
  media: Post["media"];
  status: string;
  scheduledAt: string | null;
  href: string;
  canPublish: boolean;
};

/** One channel's actual delivery records and unsent drafts; never a publish mutation. */
export async function loadTodayPublications(
  db: Pick<Pool | PoolClient, "query">,
  scope: { projectId: number; channelId: number; timezone: string; canPublish: boolean },
): Promise<TodayPublication[]> {
  const rows = (await db.query<{
    key: string; draft_id: string | null; draft_version: string | null; text: string;
    media: Post["media"]; status: string; scheduled_at: string | null;
    operation_id: string | null; destination_count: number; is_autopilot: boolean;
  }>(
    `select * from (
       select 'post:' || post.id as key, operation.draft_id, operation.draft_version,
              post.text, post.media, post.status, post.scheduled_at::text,
              operation.id as operation_id, 0::int as destination_count, false as is_autopilot
         from posts post
         left join publication_operations operation
           on operation.id = post.publication_operation_id and operation.project_id = post.project_id
        where post.project_id = $1 and post.channel_id = $2
          and (
            (coalesce(post.published_at, post.scheduled_at) at time zone $3)::date = (now() at time zone $3)::date
            or (post.status in ('failed','failed_retry','quarantined','publishing','published_unverified')
                and post.scheduled_at >= now() - interval '7 days')
          )
          and (operation.id is null or operation.status <> 'cancelled')
       union all
       select 'draft:' || draft.id, draft.id, draft.version, draft.text, draft.media,
              coalesce(workflow.state, 'draft'), draft.scheduled_at::text, null::bigint,
              (select count(*)::int from draft_destinations all_destinations where all_destinations.draft_id = draft.id),
              draft.client_key like 'autopilot-item:%' as is_autopilot
         from drafts draft
         join draft_destinations destination on destination.draft_id = draft.id and destination.channel_id = $2
         left join draft_editorial_workflows workflow on workflow.draft_id = draft.id and workflow.project_id = draft.project_id
        where draft.project_id = $1 and draft.purpose <> 'source_context'
          and ((draft.scheduled_at at time zone $3)::date = (now() at time zone $3)::date
               or (draft.scheduled_at is null and (workflow.state = 'approved' or draft.updated_at >= now() - interval '7 days')))
          and not exists (select 1 from publication_operations operation
            where operation.project_id = $1 and operation.draft_id = draft.id and operation.status <> 'cancelled')
     ) queue
     order by case status when 'failed' then 0 when 'quarantined' then 0 when 'approved' then 1
                when 'changes_requested' then 2 when 'in_review' then 2 when 'published' then 4 else 3 end,
              scheduled_at nulls last, key
     limit 30`,
    [scope.projectId, scope.channelId, scope.timezone],
  )).rows;
  return rows.map((row) => ({
    key: row.key,
    draftId: row.draft_id == null ? null : Number(row.draft_id),
    draftVersion: row.draft_version == null ? null : Number(row.draft_version),
    text: row.text,
    media: row.media,
    status: row.status,
    scheduledAt: row.scheduled_at,
    href: row.is_autopilot ? `/app/autopilot?channel=${scope.channelId}` : row.draft_id
      ? `/app/composer?draft=${row.draft_id}${row.operation_id ? `&publication=${row.operation_id}` : ""}&from=today`
      : `/app/calendar?channel=${scope.channelId}`,
    // The existing publication endpoint rechecks role, approval, revision and destinations.
    canPublish: scope.canPublish && !row.is_autopilot && row.key.startsWith("draft:") && row.status === "approved" && Number(row.destination_count) === 1,
  }));
}
