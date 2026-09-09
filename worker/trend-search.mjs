import { median } from "../src/lib/radar-search.mjs";

export const TREND_SEARCH_MAX_CHANNELS = 18;
export const TREND_SEARCH_MAX_PAGES = 12;
export const TREND_SEARCH_DEADLINE_MS = 120_000;

export function matureTrendBaseline(posts, measuredAt = Date.now()) {
  const counts = posts.filter((post) => {
    const published = Date.parse(String(post.postedAt || ""));
    return post.views != null && Number.isFinite(Number(post.views)) && Number(post.views) >= 0
      && published <= measuredAt - 48 * 3_600_000 && published >= measuredAt - 90 * 86_400_000;
  }).map((post) => Number(post.views));
  return { medianViews: counts.length >= 5 ? median(counts) : null, baselinePosts: counts.length };
}

/** A threshold is a classification; only this measured ratio may be displayed. */
export function matureTrendRatio(post, baseline, measuredAt = Date.now()) {
  const published = Date.parse(String(post?.postedAt || ""));
  if (post?.views == null || !Number.isFinite(Number(post.views)) || Number(post.views) < 0
    || !Number.isFinite(published) || published > measuredAt - 48 * 3_600_000
    || baseline.baselinePosts < 5 || !(baseline.medianViews > 0)) return null;
  return Number(post.views) / baseline.medianViews;
}

export function trendHistoryBoundary(posts, since) {
  const timestamps = posts.map((post) => Date.parse(String(post.postedAt || ""))).filter(Number.isFinite);
  return timestamps.length > 0 && Math.min(...timestamps) <= since;
}

/** Claim legacy queued runs created while the old web was still serving the migration. */
export async function claimRadarSearchRun(db, runId, userId) {
  const result = await db.query(
    `with eligible as (
      select run.id, coalesce(run.project_id, channel.project_id, personal.id) as project_id
        from radar_search_runs run
        left join channels channel on channel.id = run.channel_id
        left join projects personal on personal.personal_owner_user_id = run.user_id
       where run.id = $1 and run.user_id = $2 and run.status = 'queued'
    )
    update radar_search_runs run
       set project_id = eligible.project_id, status = 'running', stage = 'discovering', progress = 8,
           error_code = null, error_message = null, updated_at = now()
      from eligible
     where run.id = eligible.id and run.status = 'queued'
       and exists (select 1 from project_members member
         join projects project on project.id = member.project_id and project.is_archived = false
         where member.project_id = eligible.project_id and member.user_id = $2
           and member.status = 'active' and member.role in ('owner','author','approver'))
    returning run.id, run.channel_id, run.project_id, run.query, run.normalized_query,
              run.local_count, run.search_scope, run.search_period`,
    [runId, userId],
  );
  return result.rows[0] || null;
}
