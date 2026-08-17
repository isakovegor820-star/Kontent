import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { getPublishQueue, jobIdForPost, jobIdForPostRevision } from "@/lib/queue";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type CancelledPost = {
  post_id: string;
  item_id: string;
  schedule_revision: string;
};

async function removePublishJobs(posts: CancelledPost[]) {
  if (!posts.length) return;
  const queue = getPublishQueue();
  await Promise.all(posts.flatMap((post) => (
    [
      jobIdForPost(post.post_id),
      jobIdForPostRevision(post.post_id, post.schedule_revision),
    ].map(async (jobId) => {
      const job = await queue.getJob(jobId).catch(() => null);
      if (job) await job.remove().catch(() => {});
    })
  )));
}

export async function PATCH(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as {
    channelId?: unknown;
    enabled?: unknown;
  } | null;
  const channelId = Number(body?.channelId);
  if (!Number.isSafeInteger(channelId) || channelId <= 0 || typeof body?.enabled !== "boolean") {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 422 });
  }
  const enabled = body.enabled;
  const pool = getPool();

  try {
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.publish");
    const channel = (
      await pool.query<{ id: string }>(
        `select id
           from channels
          where id = $1 and user_id = $2 and project_id = $3
            and is_active and status = 'active' and network in ('tg', 'vk')`,
        [channelId, user.id, membership.projectId],
      )
    ).rows[0];
    if (!channel) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const client = await pool.connect();
    let cancelled: CancelledPost[] = [];
    let publishingNow = 0;
    try {
      await client.query("begin");
      const feeds = (
        await client.query<{ id: string }>(
          `select id
             from rss_feeds
            where user_id = $1 and channel_id = $2
              and source_kind = 'legal_opportunity' and is_active = true
            order by id
            for update`,
          [user.id, channelId],
        )
      ).rows;
      if (!feeds.length) {
        await client.query("rollback");
        return NextResponse.json({ ok: false, error: "no_sources" }, { status: 422 });
      }
      const feedIds = feeds.map((feed) => feed.id);

      if (enabled) {
        // Всё, что уже было найдено до включения, остаётся только в подборке.
        // Автопубликация начинает работать с первого следующего нового GUID.
        await client.query(
          `update rss_items
              set status = 'skipped', skip_reason = 'baseline'
            where feed_id = any($1::bigint[]) and status = 'new'`,
          [feedIds],
        );
        await client.query(
          `update rss_feeds
              set auto_publish_enabled = true
            where id = any($1::bigint[])`,
          [feedIds],
        );
      } else {
        await client.query(
          `update rss_feeds
              set auto_publish_enabled = false
            where user_id = $1 and channel_id = $2
              and source_kind = 'legal_opportunity'`,
          [user.id, channelId],
        );
        cancelled = (
          await client.query<CancelledPost>(
            `select p.id as post_id, i.id as item_id, p.schedule_revision
               from rss_items i
               join posts p on p.id = i.post_id
              where i.feed_id = any($1::bigint[])
                and (
                  p.status in ('scheduled', 'failed_retry')
                  or (p.status = 'publishing' and p.provider_started_at is null)
                )
              order by p.id
              for update of p, i`,
            [feedIds],
          )
        ).rows;
        if (cancelled.length) {
          const postIds = cancelled.map((post) => post.post_id);
          const itemIds = cancelled.map((post) => post.item_id);
          await client.query(
            `update posts
                set status = 'cancelled', cancelled_at = now(),
                    publish_lease_token = null, publish_started_at = null,
                    provider_started_at = null, next_attempt_at = null
              where id = any($1::bigint[])
                and (
                  status in ('scheduled', 'failed_retry')
                  or (status = 'publishing' and provider_started_at is null)
                )`,
            [postIds],
          );
          await client.query(
            `update rss_items
                set status = 'skipped', skip_reason = 'paused', post_id = null
              where id = any($1::bigint[])`,
            [itemIds],
          );
        }
        publishingNow = Number((
          await client.query<{ count: string }>(
            `select count(distinct p.id)::int as count
               from rss_items i
               join posts p on p.id = i.post_id
              where i.feed_id = any($1::bigint[])
                and p.status = 'publishing' and p.provider_started_at is not null`,
            [feedIds],
          )
        ).rows[0]?.count || 0);
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    await removePublishJobs(cancelled);
    return NextResponse.json({
      ok: true,
      autoPublishEnabled: enabled,
      cancelled: cancelled.length,
      publishingNow,
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/rss/auto-publish] PATCH", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
