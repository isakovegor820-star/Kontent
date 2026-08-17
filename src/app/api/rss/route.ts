// RSS-ленты: GET — список фидов юзера, POST — добавить фид.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { fetchPublicText } from "@/lib/safe-http.mjs";
import { parseRss } from "../../../../worker/lib.mjs";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sourceKind = req.nextUrl.searchParams.get("sourceKind");
  if (sourceKind !== null && sourceKind !== "manual" && sourceKind !== "legal_opportunity") {
    return NextResponse.json({ error: "bad_source_kind" }, { status: 400 });
  }

  try {
    const r = await getPool().query(
      `select f.id, f.url, f.title, f.channel_id, f.is_active, f.auto_publish_enabled,
              f.ai_summarize, f.source_kind,
              f.publish_existing, f.max_per_day,
              f.last_fetched_at, f.created_at, c.title as channel_title,
              coalesce(activity.items_24h, 0) as items_24h,
              coalesce(activity.posted_24h, 0) as posted_24h,
              coalesce(activity.skipped_24h, 0) as skipped_24h,
              coalesce(activity.limited_24h, 0) as limited_24h,
              coalesce(activity.irrelevant_24h, 0) as irrelevant_24h,
              coalesce(activity.baseline_24h, 0) as baseline_24h,
              coalesce(activity.paused_24h, 0) as paused_24h
         from rss_feeds f
         left join channels c on c.id = f.channel_id
         left join lateral (
           select count(*)::int as items_24h,
                  count(*) filter (where i.status = 'posted')::int as posted_24h,
                  count(*) filter (where i.status = 'skipped')::int as skipped_24h,
                  count(*) filter (where i.skip_reason = 'limit')::int as limited_24h,
                  count(*) filter (where i.skip_reason = 'irrelevant')::int as irrelevant_24h,
                  count(*) filter (where i.skip_reason = 'baseline')::int as baseline_24h,
                  count(*) filter (where i.skip_reason = 'paused')::int as paused_24h
             from rss_items i
            where i.feed_id = f.id
              and i.fetched_at > now() - interval '24 hours'
         ) activity on true
        where f.user_id = $1
          and ($2::text is null or f.source_kind = $2)
        order by f.created_at desc`,
      [user.id, sourceKind],
    );
    return NextResponse.json({
      feeds: r.rows.map((feed) => ({
        ...feed,
        // PostgreSQL bigint приходит строкой. На клиенте эти значения участвуют
        // в сравнении выбранного канала и источника, поэтому контракт — number.
        id: Number(feed.id),
        channel_id: Number(feed.channel_id),
      })),
    });
  } catch (err) {
    console.error("[/api/rss] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: {
    url?: unknown;
    channelId?: unknown;
    aiSummarize?: unknown;
    includeExisting?: unknown;
    maxPerDay?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const url = String(body.url ?? "").trim().slice(0, 500);
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ ok: false, error: "bad_url" }, { status: 422 });
  }

  const channelId = body.channelId;
  if (typeof channelId !== "number" || !Number.isSafeInteger(channelId) || channelId <= 0) {
    return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
  }

  // Проверяем, что канал принадлежит юзеру
  const ch = await getPool().query(
    `select id from channels
      where id = $1 and user_id = $2 and is_active and network in ('tg', 'vk')`,
    [channelId, user.id],
  );
  if (!ch.rowCount) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

  const aiSummarize = body.aiSummarize !== false;
  const includeExisting = body.includeExisting === true;
  const maxPerDay = body.maxPerDay ?? 3;
  if (typeof maxPerDay !== "number" || !Number.isInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 20) {
    return NextResponse.json({ ok: false, error: "bad_limit" }, { status: 422 });
  }

  // Проверяем, что фид живой (fetch с таймаутом)
  let title: string | null = null;
  let itemCount = 0;
  try {
    const res = await fetchPublicText(url, {
      timeoutMs: 10_000,
      maxBytes: 2 * 1024 * 1024,
      headers: { "user-agent": "Aurora-RSS/1.0" },
    });
    if (!res.ok) return NextResponse.json({ ok: false, error: "fetch_failed" }, { status: 422 });
    const xml = await res.text();
    const parsedItems = parseRss(xml);
    if (!parsedItems.length) {
      return NextResponse.json({ ok: false, error: "not_feed" }, { status: 422 });
    }
    itemCount = parsedItems.length;
    // Достаём title канала из XML
    const m = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim().slice(0, 200) : null;
  } catch {
    return NextResponse.json({ ok: false, error: "fetch_failed" }, { status: 422 });
  }

  try {
    const r = await getPool().query(
      `insert into rss_feeds (
         user_id, channel_id, url, title, is_active, ai_summarize, publish_existing,
         source_kind, max_per_day, last_fetched_at
       )
       values ($1, $2, $3, $4, false, $5, $6, 'manual', $7, null)
       on conflict (user_id, url) do update set
         is_active = false,
         channel_id = excluded.channel_id,
         title = excluded.title,
         ai_summarize = excluded.ai_summarize,
         publish_existing = excluded.publish_existing,
         source_kind = 'manual',
         max_per_day = excluded.max_per_day,
         last_fetched_at = null
       returning id, is_active`,
      [user.id, channelId, url, title, aiSummarize, includeExisting, maxPerDay],
    );
    return NextResponse.json({
      ok: true,
      id: Number(r.rows[0]?.id),
      title,
      itemCount,
      isActive: Boolean(r.rows[0]?.is_active),
    });
  } catch (err) {
    console.error("[/api/rss] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
