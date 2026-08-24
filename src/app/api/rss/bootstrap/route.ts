import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { getStatsQueue } from "@/lib/queue";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { listPublicLegalRssSources } from "@/lib/rss-catalog";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await readJsonBodyValue(req).catch(() => null) as { channelId?: unknown } | null;
  const wantedChannelId = Number(body?.channelId);
  if (!Number.isSafeInteger(wantedChannelId) || wantedChannelId <= 0) {
    return NextResponse.json({ ok: false, error: "bad_channel" }, { status: 422 });
  }

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.create");
    const channel = (
      await pool.query<{ id: string }>(
        `select id
           from channels
          where id = $1 and user_id = $2 and project_id = $3
            and is_active and status = 'active' and network in ('tg', 'vk')`,
        [wantedChannelId, user.id, membership.projectId],
      )
    ).rows[0];
    if (!channel) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const sources = listPublicLegalRssSources();
    const existingAutoPublish = (
      await pool.query<{ enabled: boolean }>(
        `select coalesce(bool_or(auto_publish_enabled), false) as enabled
           from rss_feeds
          where user_id = $1 and channel_id = $2
            and source_kind = 'legal_opportunity' and is_active = true`,
        [user.id, wantedChannelId],
      )
    ).rows[0]?.enabled === true;
    await pool.query(
      `update rss_feeds
          set is_active = false
        where user_id = $1 and channel_id = $2
          and source_kind = 'legal_opportunity'
          and not (url = any($3::text[]))`,
      [user.id, wantedChannelId, sources.map((source) => source.url)],
    );
    const connected = [] as Array<{ id: number; title: string }>;
    for (const source of sources) {
      const inserted = await pool.query<{ id: string }>(
        `insert into rss_feeds (
         user_id, channel_id, url, title, is_active, ai_summarize,
           publish_existing, source_kind, max_per_day, last_fetched_at, auto_publish_enabled
         )
         values ($1, $2, $3, $4, true, true, false, 'legal_opportunity', 3, null, $5)
         on conflict (user_id, url) do update set
           channel_id = excluded.channel_id,
           title = excluded.title,
           is_active = true,
           ai_summarize = true,
           source_kind = 'legal_opportunity',
           auto_publish_enabled = excluded.auto_publish_enabled,
           max_per_day = greatest(rss_feeds.max_per_day, excluded.max_per_day)
         returning id`,
        [user.id, wantedChannelId, source.url, source.title, existingAutoPublish],
      );
      const id = Number(inserted.rows[0]?.id);
      if (Number.isSafeInteger(id) && id > 0) connected.push({ id, title: source.title });
    }

    let refreshQueued = false;
    try {
      await getStatsQueue().add(
        "rss-now",
        { userId: user.id, channelId: wantedChannelId },
        {
          jobId: `legal-opportunities-bootstrap-${user.id}-${wantedChannelId}`,
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 2,
          backoff: { type: "fixed", delay: 15_000 },
        },
      );
      refreshQueued = true;
    } catch (error) {
      console.error("[/api/rss/bootstrap] queue", {
        errorName: error instanceof Error ? error.name : "Error",
      });
    }

    return NextResponse.json({
      ok: true,
      connected,
      refreshQueued,
      autoPublishEnabled: existingAutoPublish,
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/rss/bootstrap] POST", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
