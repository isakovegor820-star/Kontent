import { withProjectRoute } from "@/lib/project-route";
import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";

import { saveRssSubscription, withRssChannel } from "@/lib/rss-subscriptions";
import { ProjectAccessError } from "@/lib/project-permissions";
import { getStatsQueue } from "@/lib/queue";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { listPublicLegalRssSources } from "@/lib/rss-catalog";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

async function handlePOST(req: NextRequest) {
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
    const saved = await withRssChannel(user.id, wantedChannelId, "content.create", async (client, projectId) => {
      const sources = listPublicLegalRssSources();
      const existingAutoPublish = (await client.query<{ enabled: boolean }>(
        `select coalesce(bool_or(auto_publish_enabled), false) as enabled from rss_feeds
          where channel_id = $1 and source_kind = 'legal_opportunity' and is_active = true`,
        [wantedChannelId],
      )).rows[0]?.enabled === true;
      await client.query(
        `update rss_feeds set is_active = false where channel_id = $1
          and source_kind = 'legal_opportunity' and not (url = any($2::text[]))`,
        [wantedChannelId, sources.map((source) => source.url)],
      );
      const connected = [] as Array<{ id: number; title: string }>;
      for (const source of sources) {
        const row = await saveRssSubscription(client, {
          actorUserId: user.id, channelId: wantedChannelId, url: source.url, title: source.title,
          kind: "legal_opportunity", aiSummarize: true, publishExisting: false, maxPerDay: 3,
          autoPublishEnabled: existingAutoPublish,
        });
        connected.push({ id: row.id, title: source.title });
      }
      return { connected, autoPublishEnabled: existingAutoPublish, projectId };
    });
    if (!saved) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    let refreshQueued = false;
    try {
      await getStatsQueue().add(
        "rss-now",
        { userId: user.id, projectId: saved.projectId, channelId: wantedChannelId },
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
      connected: saved.connected,
      refreshQueued,
      autoPublishEnabled: saved.autoPublishEnabled,
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

export const POST = withProjectRoute(handlePOST);
