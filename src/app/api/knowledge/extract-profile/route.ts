// Профиль канала: ИИ сам читает посты и вытаскивает «что это за бизнес» — человеку
// заполнять базу знаний руками больше не нужно (она стала невидимой).
//
// POST — прочитать канал и извлечь профиль (онбординг, кнопка «перечитать»).
// PUT  — сохранить профиль после правок человека или из интервью (когда канал приватный
//        и читать нечего). Различаем kind: авто-извлечённый 'profile' еженедельный крон
//        может перезаписать свежим; 'profile_edit' — слова самого человека, его НЕ трогаем.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { resolveChannel } from "@/lib/autopilot";
import { fetchPublicPosts } from "@/lib/tg-public";
import { completeText } from "@/lib/ai-provider";
import {
  buildExtractionMessages,
  isMeaningfulProfile,
  normalizeProfile,
  parseProfile,
  profileToSourceText,
  type ChannelProfile,
} from "@/lib/channel-profile.mjs";

export const runtime = "nodejs";

// Меньше трёх осмысленных постов — профиль будет гаданием. Честно говорим «не прочитал»,
// и онбординг переключается на интервью (человек рассказывает сам).
const MIN_POSTS = 3;

/** Заменить профильный источник канала. Правка человека (profile_edit) сносит и авто-профиль:
 * иначе в базе жили бы две версии «кто я» с разными цифрами, и ИИ опирался бы на обе. */
async function saveProfileSource(
  userId: number,
  channelId: number,
  title: string,
  profile: ChannelProfile,
  kind: "profile" | "profile_edit",
) {
  const pool = getPool();
  const wipe = kind === "profile_edit" ? ["profile", "profile_edit"] : [kind];
  await pool.query(`delete from knowledge_sources where channel_id = $1 and kind = any($2)`, [
    channelId,
    wipe,
  ]);
  const ins = await pool.query<{ id: number }>(
    `insert into knowledge_sources (user_id, channel_id, kind, title, raw_text)
     values ($1, $2, $3, $4, $5) returning id`,
    [userId, channelId, kind, title, profileToSourceText(profile)],
  );
  await getStatsQueue()
    .add(
      "knowledge-index",
      { sourceId: Number(ins.rows[0].id) },
      { removeOnComplete: true, attempts: 3, backoff: { type: "fixed", delay: 20000 } },
    )
    .catch(() => {
      /* очередь легла — источник висит pending, суточный цикл подберёт */
    });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { channelId?: number };

  try {
    const pool = getPool();
    const channelId = await resolveChannel(user.id, body.channelId ?? null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const ch = (
      await pool.query<{ handle: string | null; title: string | null }>(
        `select handle, title from channels where id = $1`,
        [channelId],
      )
    ).rows[0];
    if (!ch?.handle) return NextResponse.json({ ok: false, error: "no_handle" }, { status: 422 });

    const page = await fetchPublicPosts(ch.handle, 20);
    const posts = (page.posts || []).map((t) => t.trim()).filter((t) => t.length >= 40);
    if (posts.length < MIN_POSTS) {
      return NextResponse.json({ ok: false, error: "no_posts" }, { status: 422 });
    }

    const { system, user: prompt } = buildExtractionMessages(ch.title ?? ch.handle, posts);
    let profile: ChannelProfile | null = null;
    try {
      const raw = await completeText(system, prompt, { temperature: 0.2, maxTokens: 700 });
      profile = parseProfile(raw);
    } catch (err) {
      console.error("[/api/knowledge/extract-profile] движок:", err);
      return NextResponse.json({ ok: false, error: "ai_unavailable" }, { status: 503 });
    }
    if (!profile) {
      return NextResponse.json({ ok: false, error: "extract_failed" }, { status: 422 });
    }

    await saveProfileSource(user.id, channelId, `Профиль канала «${ch.title || ch.handle}»`, profile, "profile");
    return NextResponse.json({ ok: true, profile, posts: posts.length });
  } catch (err) {
    console.error("[/api/knowledge/extract-profile] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { channelId?: number; profile?: unknown }
    | null;
  if (!body) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  const profile = normalizeProfile(body.profile);
  if (!isMeaningfulProfile(profile)) {
    return NextResponse.json({ ok: false, error: "empty" }, { status: 422 });
  }

  try {
    const pool = getPool();
    const channelId = await resolveChannel(user.id, body.channelId ?? null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const ch = (
      await pool.query<{ title: string | null }>(`select title from channels where id = $1`, [
        channelId,
      ])
    ).rows[0];

    // Правка человека — kind='profile_edit': слова владельца важнее авто-извлечения,
    // и еженедельное обновление профилей этот источник обходит стороной.
    await saveProfileSource(user.id, channelId, `Профиль канала «${ch?.title || "без названия"}»`, profile, "profile_edit");
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/knowledge/extract-profile] PUT", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
