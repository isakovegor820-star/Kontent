// Генерация контента ИИ (ТЗ Д.8). Стримит ответ по мере генерации. Перед генерацией:
// проверяем дневной лимит, подкладываем прошлые посты пользователя как образец стиля.
// Движок скрыт за переходником ai-provider — этот роут не знает, Ollama там или облако.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { generateText, type AiKind, type GenerateParams } from "@/lib/ai-provider";
import { AI_DAILY_LIMIT, aiUsedToday, recordAiUsage, styleSamplesFor } from "@/lib/ai-usage";
import { getEngine } from "@/lib/engines";

export const runtime = "nodejs";

const KINDS: AiKind[] = ["write", "rewrite", "shorten", "plan", "script", "image"];

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { command?: unknown; input?: unknown; context?: unknown; niche?: unknown; tone?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const kind: AiKind = KINDS.includes(body.command as AiKind) ? (body.command as AiKind) : "write";
  const task = String(body.input ?? "").trim();
  const context = body.context ? String(body.context).slice(0, 600) : undefined;
  const niche = body.niche ? String(body.niche).slice(0, 120) : undefined;
  const tone = body.tone ? String(body.tone).slice(0, 120) : undefined;

  // Картинки этот движок не умеет — честно, без выдумки (ТЗ Д.8: для картинок нужен
  // отдельный сервис IMAGE_API_KEY). Лимит на это не тратим.
  if (kind === "image") {
    const msg =
      "Картинки я пока не рисую — для этого нужен отдельный сервис генерации изображений, его подключим позже. А текст поста, план на неделю или сценарий видео — попроси, сделаю.";
    return new Response(msg, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (!task && kind !== "plan") {
    return NextResponse.json({ error: "empty" }, { status: 422 });
  }

  // Честный дневной лимит.
  const used = await aiUsedToday(user.id);
  if (used >= AI_DAILY_LIMIT) {
    return NextResponse.json({ error: "limit", used, limit: AI_DAILY_LIMIT }, { status: 429 });
  }

  // Настроение и выбранный движок берём из БД (источник правды на сервере, клиент не подделает).
  const me = (
    await getPool().query<{ ai_mood: string | null; ai_engine: string | null }>(
      `select ai_mood, ai_engine from users where id = $1`,
      [user.id],
    )
  ).rows[0];
  const mood = me?.ai_mood;

  // Человек выбрал облачный движок, а ключа нет — честно отказываем. Писать тайком локальной
  // моделью и выдавать это за выбранную — ровно тот обман, которого продукт не допускает.
  // Выбор при этом сохранён: появится ключ — заработает без правок.
  const chosen = me?.ai_engine;
  if (chosen && chosen !== "local" && !process.env.AI_API_KEY) {
    const e = getEngine(chosen);
    return NextResponse.json(
      {
        error: "engine_not_connected",
        engine: e.id,
        label: `${e.label} (${e.vendor})`,
        needs: e.needs,
      },
      { status: 503 },
    );
  }

  const params: GenerateParams = {
    kind,
    task,
    context,
    niche,
    tone,
    mood: mood ?? undefined,
    styleSamples: await styleSamplesFor(user.id),
  };

  // Тянем первый кусок ДО стрима — чтобы поймать «движок недоступен» и вернуть честный 503,
  // а не оборванный поток (при 200 статус уже не поменять).
  const gen = generateText(params, req.signal);
  let first: IteratorResult<string>;
  try {
    first = await gen.next();
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }

  // Генерация реально пошла — засчитываем одну генерацию.
  await recordAiUsage(user.id, kind).catch(() => {});

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!first.done && first.value) controller.enqueue(encoder.encode(first.value));
        for await (const piece of gen) controller.enqueue(encoder.encode(piece));
      } catch {
        /* клиент отменил или сеть пропала — отдаём, что успели */
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-ai-used": String(used + 1),
      "x-ai-limit": String(AI_DAILY_LIMIT),
    },
  });
}
