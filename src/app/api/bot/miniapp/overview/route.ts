import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { validateTelegramMiniAppData } from "@/lib/telegram-mini-app";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const identity = validateTelegramMiniAppData(
    req.headers.get("x-telegram-init-data") || "",
    process.env.TG_BOT_TOKEN || "",
  );
  if (!identity) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const pool = getPool();
  const account = (
    await pool.query(
      `select user_account.id
         from users user_account
        where user_account.tg_chat_id = $1`,
      [identity.userId],
    )
  ).rows[0];
  if (!account) return NextResponse.json({ ok: false, error: "account_not_linked" }, { status: 403 });
  const overview = (
    await pool.query(
      `select project.id, project.name, project.timezone, member.role,
              (select count(*)::int from posts post
                where post.project_id = project.id and post.status = 'scheduled' and post.scheduled_at >= now()) as scheduled,
              (select count(*)::int from posts post
                where post.project_id = project.id and post.status = 'failed'
                  and coalesce(post.scheduled_at, post.created_at) >= now() - interval '7 days') as failed,
              (select count(*)::int from channels channel
                where channel.project_id = project.id and channel.is_active = true and channel.status <> 'active') as reconnect,
              (select count(*)::int from draft_editorial_requests request
                where request.project_id = project.id and request.status = 'open') as reviews,
              (select count(*)::int from posts post
                where post.project_id = project.id and post.status = 'published'
                  and post.published_at >= now() - interval '7 days') as published_week
         from user_project_preferences preference
         join projects project on project.id = preference.selected_project_id and project.is_archived = false
         join project_members member
           on member.project_id = project.id and member.user_id = preference.user_id and member.status = 'active'
        where preference.user_id = $1`,
      [account.id],
    )
  ).rows[0];
  if (!overview) return NextResponse.json({ ok: false, error: "project_not_selected" }, { status: 404 });
  const upcoming = (
    await pool.query(
      `select post.id, post.text, post.scheduled_at,
              coalesce(nullif(btrim(channel.title), ''), channel.handle, 'Канал') as channel
         from posts post
         join channels channel on channel.id = post.channel_id and channel.project_id = post.project_id
        where post.project_id = $1 and post.status = 'scheduled' and post.scheduled_at >= now()
        order by post.scheduled_at, post.id limit 4`,
      [overview.id],
    )
  ).rows;
  return NextResponse.json({
    ok: true,
    overview: {
      project: overview.name,
      timezone: overview.timezone || "UTC",
      role: overview.role,
      scheduled: Number(overview.scheduled),
      failed: Number(overview.failed),
      reconnect: Number(overview.reconnect),
      reviews: Number(overview.reviews),
      publishedWeek: Number(overview.published_week),
      upcoming: upcoming.map((item) => ({
        id: Number(item.id),
        text: String(item.text || "").slice(0, 160),
        scheduledAt: new Date(item.scheduled_at).toISOString(),
        channel: item.channel,
      })),
    },
  });
}
