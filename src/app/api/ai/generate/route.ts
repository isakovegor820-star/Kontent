// Генерация контента ИИ (ТЗ Д.8). Стримит ответ по мере генерации. Перед генерацией:
// проверяем дневной лимит, подкладываем прошлые посты пользователя как образец стиля.
// Движок скрыт за переходником ai-provider — этот роут не знает, Ollama там или облако.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import {
  generateText,
  resolveEngineRuntime,
  type AiKind,
  type AiRole,
  type ConversationTurn,
  type GenerateParams,
} from "@/lib/ai-provider";
import {
  AI_DAILY_LIMIT,
  aiUsedToday,
  channelAiContextFor,
  recordAiUsage,
  styleSamplesFor,
} from "@/lib/ai-usage";
import { DEFAULT_ENGINE, getEngine, isEngineId } from "@/lib/engines";

export const runtime = "nodejs";

const KINDS: AiKind[] = ["write", "rewrite", "shorten", "plan", "script", "image", "poll", "longread"];
const ROLES: AiRole[] = ["copywriter", "strategist", "critic"];
const EDITORIAL_KINDS: AiKind[] = ["write", "rewrite", "shorten", "script", "poll", "longread"];

function cleanHistory(value: unknown): ConversationTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): ConversationTurn | null => {
      if (!item || typeof item !== "object") return null;
      const raw = item as { role?: unknown; content?: unknown };
      if (raw.role !== "user" && raw.role !== "assistant") return null;
      const content = String(raw.content ?? "").trim().slice(0, 1800);
      return content ? { role: raw.role, content } : null;
    })
    .filter((item): item is ConversationTurn => item !== null)
    .slice(-8);
}

async function collectText(stream: AsyncGenerator<string>): Promise<string> {
  let result = "";
  for await (const piece of stream) result += piece;
  return result.trim();
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    command?: unknown;
    input?: unknown;
    context?: unknown;
    niche?: unknown;
    tone?: unknown;
    role?: unknown;
    surface?: unknown;
    channelId?: unknown;
    history?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const kind: AiKind = KINDS.includes(body.command as AiKind) ? (body.command as AiKind) : "write";
  const task = String(body.input ?? "").trim().slice(0, 8000);
  const studioOnly = body.surface === "studio";
  const context = !studioOnly && body.context ? String(body.context).slice(0, 600) : undefined;
  const niche = body.niche ? String(body.niche).slice(0, 120) : undefined;
  const tone = body.tone ? String(body.tone).slice(0, 120) : undefined;
  const role: AiRole | undefined = ROLES.includes(body.role as AiRole) ? (body.role as AiRole) : undefined;
  const requestedChannelId = Number(body.channelId);
  const channelId = Number.isSafeInteger(requestedChannelId) && requestedChannelId > 0
    ? requestedChannelId
    : null;
  const conversation = cleanHistory(body.history);

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
  const chosen = isEngineId(me?.ai_engine) ? me.ai_engine : DEFAULT_ENGINE;
  const runtime = resolveEngineRuntime(chosen);
  if (!runtime.supported) {
    const e = getEngine(chosen);
    return NextResponse.json(
      {
        error: "engine_unsupported",
        engine: e.id,
        label: `${e.label} (${e.vendor})`,
        needs: e.needs,
      },
      { status: 503 },
    );
  }
  if (!runtime.configured) {
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

  const channel = await channelAiContextFor(user.id, channelId).catch((error) => {
    console.error("[/api/ai/generate] channel context", error);
    return null;
  });
  if (channelId && !channel) {
    return NextResponse.json({ error: "channel_not_found" }, { status: 422 });
  }

  const params: GenerateParams = {
    kind,
    task,
    context,
    niche,
    tone,
    mood: mood ?? undefined,
    role,
    channelTitle: channel?.title,
    network: channel?.network,
    channelProfile: channel?.profile,
    knownFacts: channel?.facts,
    conversation,
    grounding: studioOnly ? "platform" : undefined,
    styleSamples: channel?.styleSamples ?? (await styleSamplesFor(user.id)),
  };

  // В ИИ-студии пост проходит скрытый второй этап: первый вызов пишет черновик, второй
  // работает выпускающим редактором. Пользователь видит только финальную версию.
  let draft: string | undefined;
  if (studioOnly && EDITORIAL_KINDS.includes(kind) && role !== "critic") {
    try {
      draft = await collectText(generateText(params, chosen, req.signal));
    } catch {
      return NextResponse.json({ error: "unavailable" }, { status: 503 });
    }
    if (!draft) return NextResponse.json({ error: "empty_generation" }, { status: 503 });
  }

  // Тянем первый кусок финального ответа ДО стрима — после 200 статус уже не поменять.
  const gen = generateText(draft ? { ...params, draft: draft.slice(0, 12_000) } : params, chosen, req.signal);
  let first: IteratorResult<string>;
  try {
    first = await gen.next();
  } catch {
    // Редактор может временно упасть после успешного авторского прохода. Не теряем уже
    // созданный материал: честно отдаём черновик, а следующий запрос снова попробует два этапа.
    if (draft) {
      await recordAiUsage(user.id, kind).catch(() => {});
      return new Response(draft, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-ai-used": String(used + 1),
          "x-ai-limit": String(AI_DAILY_LIMIT),
          "x-ai-pipeline": "draft-fallback",
        },
      });
    }
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
      "x-ai-pipeline": draft ? "author-editor" : "single-pass",
    },
  });
}
