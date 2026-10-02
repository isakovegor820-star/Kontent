import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { CONSENT_KINDS, isConsentRequired, type ConsentKind } from "@/lib/consent";
import { listConsentHistory, listUserConsents, revokeConsent } from "@/lib/consent-lifecycle";
import { getPool } from "@/lib/db";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const noStore = { "cache-control": "no-store" };
const BODY_MAX_BYTES = 4 * 1024;

function json(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json({ ...body, requestId }, { status, headers: noStore });
}

/**
 * Согласия пользователя: что действует сейчас и что было раньше.
 *
 * Отдаём и текущее состояние по каждому виду (включая те, где согласия нет —
 * это видно в интерфейсе), и полную историю: она и есть доказательство,
 * которое оператор обязан уметь предъявить.
 */
export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return json(requestId, { ok: false, error: "unauthorized" }, 401);

  try {
    const pool = getPool();
    const [current, history] = await Promise.all([
      listUserConsents(pool, user.id),
      listConsentHistory(pool, user.id),
    ]);
    return json(requestId, {
      ok: true,
      required: isConsentRequired(),
      current,
      history,
    });
  } catch (error) {
    console.error("[/api/settings/consents]", {
      requestId,
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
    return json(requestId, { ok: false, error: "server" }, 500);
  }
}

/**
 * Отзыв согласия.
 *
 * Отзыв — новая запись `granted = false`, история не переписывается: иначе
 * оператор не докажет, что до отзыва обработка была законной (ч. 2 ст. 9,
 * ч. 5 ст. 21 152-ФЗ). Перед проверкой берём advisory-лок на пользователя,
 * иначе два одновременных запроса создадут два отзыва.
 */
export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req, { requireBrowserOrigin: true })) {
    return json(requestId, { ok: false, error: "forbidden" }, 403);
  }
  const user = await getSessionUser(req);
  if (!user) return json(requestId, { ok: false, error: "unauthorized" }, 401);

  const rate = await checkRateLimit(`settings:consents:${user.id}`, 20, 3600);
  if (!rate.allowed) return rateLimitResponse(rate);

  let body: unknown;
  try {
    body = await readJsonBodyValue(req, BODY_MAX_BYTES);
  } catch {
    return json(requestId, { ok: false, error: "bad_request" }, 400);
  }

  const data = (body ?? {}) as Record<string, unknown>;
  const kind = String(data.kind ?? "");
  if (!(CONSENT_KINDS as readonly string[]).includes(kind)) {
    return json(requestId, { ok: false, error: "bad_kind" }, 422);
  }

  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1, $2)", [73, user.id]);
    const result = await revokeConsent(client, {
      userId: user.id,
      kind: kind as ConsentKind,
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent"),
      source: "cabinet",
    });
    if (!result.ok) {
      await client.query("rollback");
      return json(requestId, { ok: false, error: result.error }, 409);
    }
    await client.query("commit");
    const current = await listUserConsents(getPool(), user.id);
    return json(requestId, { ok: true, revoked: true, current });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.error("[/api/settings/consents]", {
      requestId,
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
    return json(requestId, { ok: false, error: "server" }, 500);
  } finally {
    client.release();
  }
}
