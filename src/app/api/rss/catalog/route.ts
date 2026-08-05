import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { rankRssCatalog, rssCatalogSize } from "@/lib/rss-catalog";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const channelId = Number(req.nextUrl.searchParams.get("channelId"));
  if (!Number.isInteger(channelId) || channelId <= 0) {
    return NextResponse.json({ error: "bad_channel" }, { status: 400 });
  }

  try {
    const channel = (
      await getPool().query<{
        id: number;
        title: string | null;
        niche: string | null;
        profile: string | null;
      }>(
        `select c.id, c.title, b.niche,
                (select string_agg(left(ks.raw_text, 1200), ' ' order by ks.added_at desc)
                   from knowledge_sources ks
                  where ks.channel_id = c.id
                    and ks.user_id = c.user_id
                    and ks.kind in ('profile_edit', 'profile')) as profile
           from channels c
           left join content_brief b on b.channel_id = c.id and b.user_id = c.user_id
          where c.id = $1 and c.user_id = $2 and c.is_active`,
        [channelId, user.id],
      )
    ).rows[0];

    if (!channel) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const context = [channel.title, channel.niche, channel.profile].filter(Boolean).join(" ");
    const sources = rankRssCatalog(context);

    return NextResponse.json({
      sources,
      total: rssCatalogSize(),
      context: {
        channelTitle: channel.title || "Канал",
        niche: channel.niche || null,
        personalized: Boolean(channel.niche || channel.profile),
      },
    });
  } catch (error) {
    console.error("[/api/rss/catalog] GET", error);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

