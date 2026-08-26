// Профиль канала: ИИ сам читает посты и вытаскивает «что это за бизнес» — человеку
// заполнять базу знаний руками больше не нужно (она стала невидимой).
//
// POST — прочитать канал и извлечь профиль (онбординг, кнопка «перечитать»).
// PUT  — сохранить профиль после правок человека или из интервью (когда канал приватный
//        и читать нечего). Различаем kind: авто-извлечённый 'profile' еженедельный крон
//        может перезаписать свежим; 'profile_edit' — слова самого человека, его НЕ трогаем.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { enqueueKnowledgeIndex } from "@/lib/knowledge-index-queue.mjs";
import { resolveChannel } from "@/lib/autopilot";
import { fetchPublicPosts } from "@/lib/tg-public";
import { completeAiText } from "@/lib/ai-completion-service.mjs";
import { isEngineId } from "@/lib/engines";
import { finalizeAiUsage, releaseAiUsage, reserveAiUsage } from "@/lib/ai-usage";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
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
  usageReservationId: number | null = null,
) {
  const pool = getPool();
  const wipe = kind === "profile_edit" ? ["profile", "profile_edit"] : [kind];
  const tx = await pool.connect();
  let sourceId: number;
  try {
    await tx.query("begin");
    await tx.query(
      `delete from knowledge_sources
        where user_id = $1 and channel_id = $2 and kind = any($3)`,
      [userId, channelId, wipe],
    );
    const ins = await tx.query<{ id: number }>(
      `insert into knowledge_sources (user_id, channel_id, kind, title, raw_text)
       values ($1, $2, $3, $4, $5) returning id`,
      [userId, channelId, kind, title, profileToSourceText(profile)],
    );
    sourceId = Number(ins.rows[0].id);
    if (usageReservationId !== null) {
      // Профиль и списание — одна транзакция: ни сохранённого бесплатного результата,
      // ни списания за откатившееся сохранение.
      const finalized = await finalizeAiUsage(
        userId,
        usageReservationId,
        "committed",
        tx,
      );
      if (!finalized.changed) throw new Error("ai usage reservation expired or already finalized");
    }
    await tx.query("commit");
  } catch (err) {
    await tx.query("rollback").catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
  await enqueueKnowledgeIndex(getStatsQueue(), sourceId)
    .catch(() => {
      /* Источник сохранён в pending; периодическая DB→queue сверка подберёт его позже. */
    });
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = (await readJsonBodyValue(req).catch(() => ({}))) as { channelId?: number };

  let reservationId: number | null = null;
  let committed = false;
  try {
    const pool = getPool();
    const channelId = await resolveChannel(user.id, body.channelId ?? null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const ch = (
      await pool.query<{ handle: string | null; title: string | null; ai_engine: string | null }>(
        `select c.handle, c.title, u.ai_engine
           from channels c join users u on u.id = c.user_id
          where c.id = $1 and c.user_id = $2`,
        [channelId, user.id],
      )
    ).rows[0];
    if (!ch?.handle) return NextResponse.json({ ok: false, error: "no_handle" }, { status: 422 });

    const page = await fetchPublicPosts(ch.handle, 20);
    const posts = (page.posts || []).map((t) => t.trim()).filter((t) => t.length >= 40);
    if (posts.length < MIN_POSTS) {
      return NextResponse.json({ ok: false, error: "no_posts" }, { status: 422 });
    }

    const { system, user: prompt } = buildExtractionMessages(ch.title ?? ch.handle, posts);
    const reservation = await reserveAiUsage(user.id, "profile");
    if (!reservation.allowed) {
      return NextResponse.json(
        { ok: false, error: "limit", used: reservation.used, limit: reservation.limit },
        { status: 429 },
      );
    }
    reservationId = reservation.reservationId;
    let profile: ChannelProfile | null = null;
    try {
      const completed = await completeAiText({
        system,
        user: prompt,
        engine: isEngineId(ch.ai_engine) ? ch.ai_engine : null,
        temperature: 0.2,
        maxTokens: 700,
      }, { signal: req.signal });
      profile = parseProfile(completed.text);
    } catch (err) {
      console.error("[/api/knowledge/extract-profile] generation failed", {
        errorName: (err as Error)?.name || "Error",
      });
      return NextResponse.json({ ok: false, error: "ai_unavailable" }, { status: 503 });
    }
    if (!profile) {
      return NextResponse.json({ ok: false, error: "extract_failed" }, { status: 422 });
    }

    await saveProfileSource(
      user.id,
      channelId,
      `Профиль канала «${ch.title || ch.handle}»`,
      profile,
      "profile",
      reservationId,
    );
    committed = true;
    return NextResponse.json({ ok: true, profile, posts: posts.length });
  } catch (err) {
    console.error("[/api/knowledge/extract-profile] POST", {
      errorName: (err as Error)?.name || "Error",
    });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  } finally {
    if (reservationId !== null && !committed) {
      await releaseAiUsage(user.id, reservationId).catch(() => {});
    }
  }
}

export async function PUT(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = (await readJsonBodyValue(req).catch(() => null)) as
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
