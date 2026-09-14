// RSS-фид по id: DELETE — удалить, PATCH — пауза/возобновление, лимит.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db";
import { getPublishQueue, jobIdForPost } from "@/lib/queue";
import { ProjectAccessError, requireProjectPermission } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

function parseFeedId(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function lockFeedProject(client: PoolClient, feedId: number): Promise<number | null> {
  const row = (await client.query<{ project_id: number | string }>(
    `select channel.project_id
       from rss_feeds feed
       join channels channel on channel.id = feed.channel_id
      where feed.id = $1
      for update of feed`,
    [feedId],
  )).rows[0];
  const projectId = Number(row?.project_id);
  return Number.isSafeInteger(projectId) && projectId > 0 ? projectId : null;
}

async function cancelScheduledPosts(
  client: PoolClient,
  feedId: number,
  projectId: number,
  markPaused: boolean,
) {
  const targets = (
    await client.query<{ post_id: string; item_id: string }>(
      `select p.id as post_id, i.id as item_id
         from rss_items i
         join posts p on p.id = i.post_id and p.project_id = $2
        where i.feed_id = $1 and p.status = 'scheduled'
        for update of p, i`,
      [feedId, projectId],
    )
  ).rows;
  if (!targets.length) return [];

  const postIds = targets.map((target) => target.post_id);
  const deleted = await client.query<{ id: string }>(
    `delete from posts
      where id = any($1::bigint[]) and project_id = $2 and status = 'scheduled'
      returning id`,
    [postIds, projectId],
  );
  const cancelled = new Set(deleted.rows.map((row) => String(row.id)));
  if (markPaused && cancelled.size) {
    const itemIds = targets
      .filter((target) => cancelled.has(String(target.post_id)))
      .map((target) => target.item_id);
    await client.query(
      `update rss_items
          set status = 'skipped', skip_reason = 'paused', post_id = null
        where id = any($1::bigint[])`,
      [itemIds],
    );
  }
  return [...cancelled].map(Number);
}

async function removeQueueJobs(postIds: number[]) {
  if (!postIds.length) return;
  const queue = getPublishQueue();
  await Promise.all(
    postIds.map(async (postId) => {
      const job = await queue.getJob(jobIdForPost(postId)).catch(() => null);
      if (job) await job.remove().catch(() => {});
    }),
  );
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  if (!hasTrustedMutationOrigin(_req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const { id } = await params;
  const user = await getSessionUser(_req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const feedId = parseFeedId(id);
  if (feedId === null) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const projectId = await lockFeedProject(client, feedId);
    if (!projectId) {
      await client.query("rollback");
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    await requireProjectPermission(client, user.id, projectId, "content.publish");
    const cancelled = await cancelScheduledPosts(client, feedId, projectId, false);
    await client.query(
      `delete from rss_feeds feed
        using channels channel
       where feed.id = $1 and channel.id = feed.channel_id and channel.project_id = $2`,
      [feedId, projectId],
    );
    await client.query("commit");
    await removeQueueJobs(cancelled);
    return NextResponse.json({ ok: true, cancelled: cancelled.length });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/rss/[id]] DELETE", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const { id } = await params;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const feedId = parseFeedId(id);
  if (feedId === null) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  let body: unknown;
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  if (!isObject(body)) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (typeof body.isActive === "boolean") {
    sets.push(`is_active = $${i++}`);
    vals.push(body.isActive);
    // Возобновление начинает с чистой границы: текущую историю источник только
    // запомнит, а публиковать будет записи, появившиеся уже после явного включения.
    if (body.isActive) sets.push("last_fetched_at = null");
  }
  if ("maxPerDay" in body) {
    if (
      typeof body.maxPerDay !== "number" ||
      !Number.isInteger(body.maxPerDay) ||
      body.maxPerDay < 1 ||
      body.maxPerDay > 20
    ) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }
    sets.push(`max_per_day = $${i++}`);
    vals.push(body.maxPerDay);
  }
  if (typeof body.aiSummarize === "boolean") {
    sets.push(`ai_summarize = $${i++}`);
    vals.push(body.aiSummarize);
  }

  if (!sets.length) return NextResponse.json({ ok: false, error: "nothing" }, { status: 422 });

  const client = await getPool().connect();
  try {
    await client.query("begin");
    const projectId = await lockFeedProject(client, feedId);
    if (!projectId) {
      await client.query("rollback");
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    await requireProjectPermission(client, user.id, projectId, "content.publish");
    // Отмена делается и при паузе, и перед повторным включением: так старые задачи,
    // пережившие сбой Redis/API, не оживут вместе с лентой.
    const cancelled = typeof body.isActive === "boolean"
      ? await cancelScheduledPosts(client, feedId, projectId, true)
      : [];
    vals.push(feedId, projectId);
    await client.query(
      `update rss_feeds feed
          set ${sets.join(", ")}
         from channels channel
        where feed.id = $${i++}
          and channel.id = feed.channel_id
          and channel.project_id = $${i}`,
      vals,
    );
    await client.query("commit");
    await removeQueueJobs(cancelled);
    return NextResponse.json({ ok: true, cancelled: cancelled.length });
  } catch (err) {
    await client.query("rollback").catch(() => {});
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/rss/[id]] PATCH", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  } finally {
    client.release();
  }
}
