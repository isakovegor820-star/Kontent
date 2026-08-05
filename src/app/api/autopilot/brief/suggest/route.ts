// Д.9 — платформа читает ОТКРЫТУЮ страницу твоего канала и предлагает бриф.
// Ничего не сохраняет: возвращает предложение, а решает и подтверждает человек.
// Честность: не смогли прочитать канал (приватный, пустой, движок молчит) — так и
// говорим и зовём заполнить руками. Ничего не выдумываем.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { resolveChannel } from "@/lib/autopilot";
import { completeAiText } from "@/lib/ai-completion-service.mjs";
import { isEngineId } from "@/lib/engines";
import { commitAiUsage, releaseAiUsage, reserveAiUsage } from "@/lib/ai-usage";
import { RUBRIC_LABELS, normalizeBrief } from "@/lib/brief";
import { fetchPublicPosts } from "@/lib/tg-public";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

const SYSTEM = [
  "Ты — редактор Telegram-каналов. Тебе дают реальные посты канала.",
  "Твоя задача — понять, о чём канал, и заполнить бриф.",
  "",
  "Отвечай СТРОГО одним JSON-объектом, без пояснений и markdown:",
  "{",
  '  "niche": "о чём канал — конкретно, одной фразой",',
  '  "audience": "кто читатель — конкретно, одной фразой",',
  '  "goal": "зачем автор ведёт канал",',
  '  "cta": "куда автор ведёт читателя (или пустая строка, если не видно)",',
  '  "rubrics": ["форматы постов из списка ниже"],',
  '  "taboo": "чего в канале явно не бывает (или пустая строка)"',
  "}",
  "",
  `rubrics выбирай ТОЛЬКО из этого списка: ${RUBRIC_LABELS.join(", ")}.`,
  "Пиши на русском. Опирайся только на то, что реально видно в постах — не выдумывай.",
].join("\n");

/** Достаёт JSON даже если модель обернула его в текст или ```json. */
function parseJsonLoose(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  // Читаем ИМЕННО тот канал, чей бриф настраивают. Раньше здесь всегда был первый канал:
  // человек настраивал второй, жал «прочитай мой канал» — и получал бриф первого.
  const body = (await req.json().catch(() => ({}))) as { channelId?: number };
  const channelId = await resolveChannel(user.id, body.channelId ?? null);
  if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

  const ch = (
    await getPool().query<{ handle: string | null; ai_engine: string | null }>(
      `select c.handle, u.ai_engine
         from channels c join users u on u.id = c.user_id
        where c.id = $1 and c.user_id = $2`,
      [channelId, user.id],
    )
  ).rows[0];

  if (!ch?.handle) {
    return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
  }

  const page = await fetchPublicPosts(ch.handle, 15);
  const posts = page.posts.filter((t) => t.length > 40);
  // Читать нечего только если постов нет совсем: канал закрыт, пуст или одни картинки.
  // Врать про канал не будем — пусть человек заполнит руками.
  if (!page.ok || posts.length === 0) {
    return NextResponse.json(
      { ok: false, error: "not_readable", handle: ch.handle, found: posts.length },
      { status: 422 },
    );
  }

  const sample = posts.slice(0, 12).map((t, i) => `Пост ${i + 1}:\n${t.slice(0, 700)}`).join("\n\n---\n\n");

  // Квоту занимаем атомарно только когда канал действительно прочитан и сейчас пойдёт
  // платный запрос. Параллельные клики больше не обходят дневной лимит.
  const reservation = await reserveAiUsage(user.id, "brief");
  if (!reservation.allowed) {
    return NextResponse.json(
      { ok: false, error: "limit", used: reservation.used, limit: reservation.limit },
      { status: 429 },
    );
  }

  let committed = false;
  try {
    const completed = await completeAiText({
      system: SYSTEM,
      user: `Посты канала «${page.title ?? ch.handle}»:\n\n${sample}`,
      engine: isEngineId(ch.ai_engine) ? ch.ai_engine : null,
      temperature: 0.3,
      maxTokens: 700,
    }, { signal: req.signal });
    const raw = completed.text;
    const parsed = parseJsonLoose(raw);
    if (!parsed) {
      return NextResponse.json({ ok: false, error: "unparsable" }, { status: 502 });
    }

    const brief = normalizeBrief({ ...(parsed as object), source: "ai", ready: false });
    // Рубрики принимаем только из нашего списка — модель любит придумать своё.
    brief.rubrics = brief.rubrics.filter((r) => RUBRIC_LABELS.includes(r));
    if (!await commitAiUsage(user.id, reservation.reservationId)) {
      return NextResponse.json({ ok: false, error: "usage_finalize_failed" }, { status: 503 });
    }
    committed = true;

    return NextResponse.json({
      ok: true,
      brief,
      readPosts: posts.length,
      channelTitle: page.title,
      handle: ch.handle,
    });
  } catch (error) {
    console.error("[/api/autopilot/brief/suggest] generation failed", {
      errorName: (error as Error)?.name || "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  } finally {
    if (!committed) await releaseAiUsage(user.id, reservation.reservationId).catch(() => {});
  }
}
