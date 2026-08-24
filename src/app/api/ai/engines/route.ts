// Д.8 — какие движки ИИ есть, какой выбран и какой РЕАЛЬНО работает прямо сейчас.
//
// Каждый движок отдаём с честным статусом, а roadmap-интеграции нельзя выбрать.
//   ready   — работает сейчас, можно писать
//   no_key  — движок настоящий, но не подключён: нужен ключ (написано, какой именно)
//   offline — движок подключён, но не отвечает (напр. Ollama не запущен)
// Ключи наружу не отдаём никогда — только факт их наличия.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { aiReady, resolveEngineRuntime } from "@/lib/ai-provider";
import { DEFAULT_ENGINE, ENGINES, getEngine, isEngineId } from "@/lib/engines";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

function engineJson(requestId: string, payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(
    { ...payload, requestId },
    { status, headers: { "cache-control": "no-store", "x-ai-request-id": requestId } },
  );
}

function logEngineRequest(requestId: string, code: string, status: number) {
  console.error("[/api/ai/engines]", { requestId, code, status });
}

export async function GET(req: NextRequest) {
  const requestId = crypto.randomUUID();
  let user: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    user = await getSessionUser(req);
  } catch {
    logEngineRequest(requestId, "session_unavailable", 503);
    return engineJson(requestId, { error: "session_unavailable", retryable: true }, 503);
  }
  if (!user) return engineJson(requestId, { error: "unauthorized", retryable: false }, 401);

  let chosen: string | null | undefined;
  try {
    chosen = (
      await getPool().query<{ ai_engine: string | null }>(`select ai_engine from users where id = $1`, [
        user.id,
      ])
    ).rows[0]?.ai_engine;
  } catch {
    logEngineRequest(requestId, "settings_unavailable", 503);
    return engineJson(requestId, { error: "settings_unavailable", retryable: true }, 503);
  }

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
              : status === "offline"
                ? `${e.vendor} не подтвердил доступность модели ${e.model}. Проверь ключ, тариф и статус провайдера.`
                : null,
    };
  }));

  const currentState = engines.find((engine) => engine.id === current);
  const suggestedEngine = currentState?.status === "ready"
    ? null
    : engines.find((engine) => engine.id !== current && engine.supported && engine.status === "ready") ?? null;
  return engineJson(requestId, { engines, current, suggestedEngine });
}

/** Сохраняем только явно выбранный движок, который подтвердил готовность прямо сейчас. */
export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return engineJson(requestId, { ok: false, error: "forbidden_origin", retryable: false }, 403);
  }
  let user: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    user = await getSessionUser(req);
  } catch {
    logEngineRequest(requestId, "session_unavailable", 503);
    return engineJson(requestId, { ok: false, error: "session_unavailable", retryable: true }, 503);
  }
  if (!user) return engineJson(requestId, { ok: false, error: "unauthorized", retryable: false }, 401);

  let body: { engine?: unknown };
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return engineJson(requestId, { ok: false, error: "bad_request", retryable: false }, 400);
  }
  if (!isEngineId(body.engine)) {
    return engineJson(requestId, { ok: false, error: "bad_engine", retryable: false }, 422);
  }
  if (getEngine(body.engine).protocol === null) {
    return engineJson(requestId, { ok: false, error: "engine_unsupported", retryable: false }, 422);
  }
  const runtime = resolveEngineRuntime(body.engine);
  if (!runtime.configured || !await aiReady(body.engine)) {
    return engineJson(
      requestId,
      {
        ok: false,
        error: runtime.configured ? "engine_offline" : "engine_not_connected",
        engine: body.engine,
        retryable: runtime.configured,
      },
      409,
    );
  }

  try {
    await getPool().query(`update users set ai_engine = $2 where id = $1`, [user.id, body.engine]);
    return engineJson(requestId, { ok: true, engine: body.engine });
  } catch {
    logEngineRequest(requestId, "settings_write_failed", 500);
    return engineJson(requestId, { ok: false, error: "server", retryable: true }, 500);
  }
}
