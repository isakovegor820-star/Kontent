// Д.8 — какие движки ИИ есть, какой выбран и какой РЕАЛЬНО работает прямо сейчас.
//
// Пикер в студии — заглушка только в том смысле, что облачные движки ждут ключа.
// Врать он не должен: каждый движок отдаём с честным статусом, а не с видом «всё готово».
//   ready   — работает сейчас, можно писать
//   no_key  — движок настоящий, но не подключён: нужен ключ (написано, какой именно)
//   offline — движок подключён, но не отвечает (напр. Ollama не запущен)
// Ключи наружу не отдаём никогда — только факт их наличия.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { aiReady } from "@/lib/ai-provider";
import { DEFAULT_ENGINE, ENGINES, isEngineId } from "@/lib/engines";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const hasCloudKey = !!process.env.AI_API_KEY;
  // Локальный движок пингуем по-настоящему: «выбран» и «работает» — разные вещи.
  const localAlive = hasCloudKey ? false : await aiReady();

  const chosen = (
    await getPool().query<{ ai_engine: string | null }>(`select ai_engine from users where id = $1`, [
      user.id,
    ])
  ).rows[0]?.ai_engine;

  const current = isEngineId(chosen) ? chosen : DEFAULT_ENGINE;

  const engines = ENGINES.map((e) => {
    let status: "ready" | "no_key" | "offline";
    if (e.id === "local") {
      // Пока задан AI_API_KEY, переходник уходит в облако — локальный движок не у дел.
      status = hasCloudKey ? "offline" : localAlive ? "ready" : "offline";
    } else {
      status = hasCloudKey ? "ready" : "no_key";
    }
    return {
      id: e.id,
      label: e.label,
      vendor: e.vendor,
      note: e.note,
      needs: e.needs,
      model: e.model,
      ruFriendly: e.ruFriendly,
      status,
      reason:
        e.id === "local" && hasCloudKey
          ? "Задан AI_API_KEY — платформа пишет облаком. Убери ключ, чтобы вернуться на локальный."
          : e.id === "local" && !localAlive
            ? "Ollama не отвечает. Запусти её и скачай модель: ollama pull hermes3"
            : status === "no_key"
              ? `Нужен ключ в ${e.needs} (и AI_API_URL под этот движок).`
              : null,
    };
  });

  return NextResponse.json({ engines, current, hasCloudKey });
}

/** Сохранить выбор. Разрешаем выбрать и неподключённый — это заявка на будущее, не обман. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { engine?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  if (!isEngineId(body.engine)) {
    return NextResponse.json({ ok: false, error: "bad_engine" }, { status: 422 });
  }

  try {
    await getPool().query(`update users set ai_engine = $2 where id = $1`, [user.id, body.engine]);
    return NextResponse.json({ ok: true, engine: body.engine });
  } catch (err) {
    console.error("[/api/ai/engines] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
