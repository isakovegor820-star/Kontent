// Д.8 — какие движки ИИ есть, какой выбран и какой РЕАЛЬНО работает прямо сейчас.
//
// Каждый движок отдаём с честным статусом, а roadmap-интеграции нельзя выбрать.
//   ready   — работает сейчас, можно писать
//   no_key  — движок настоящий, но не подключён: нужен ключ (написано, какой именно)
//   offline — движок подключён, но не отвечает (напр. Ollama не запущен)
// Ключи наружу не отдаём никогда — только факт их наличия.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { aiReady, resolveEngineRuntime } from "@/lib/ai-provider";
import { DEFAULT_ENGINE, ENGINES, getEngine, isEngineId } from "@/lib/engines";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const chosen = (
    await getPool().query<{ ai_engine: string | null }>(`select ai_engine from users where id = $1`, [
      user.id,
    ])
  ).rows[0]?.ai_engine;

  const current = isEngineId(chosen) ? chosen : DEFAULT_ENGINE;

  const engines = await Promise.all(ENGINES.map(async (e) => {
    const runtime = resolveEngineRuntime(e.id);
    let status: "ready" | "no_key" | "offline";
    if (!runtime.supported) status = "offline";
    else if (!runtime.configured) status = "no_key";
    else status = (await aiReady(e.id)) ? "ready" : "offline";
    return {
      id: e.id,
      label: e.label,
      vendor: e.vendor,
      note: e.note,
      needs: e.needs,
      model: e.model,
      recommended: e.recommended ?? false,
      ruFriendly: e.ruFriendly,
      supported: runtime.supported,
      status,
      reason:
        !runtime.supported
          ? `Интеграция ещё не реализована: нужен ${e.needs}.`
          : e.id === "local" && status === "offline"
            ? "Ollama не отвечает. Запусти её и скачай модель: ollama pull hermes3"
            : status === "no_key"
              ? `Нужен ключ в ${e.needs}.`
              : null,
    };
  }));

  return NextResponse.json({ engines, current });
}

/** Сохраняем поддерживаемый движок; ключ можно подключить позже. */
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
  if (getEngine(body.engine).protocol === null) {
    return NextResponse.json({ ok: false, error: "engine_unsupported" }, { status: 422 });
  }

  try {
    await getPool().query(`update users set ai_engine = $2 where id = $1`, [user.id, body.engine]);
    return NextResponse.json({ ok: true, engine: body.engine });
  } catch (err) {
    console.error("[/api/ai/engines] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
