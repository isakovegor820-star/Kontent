import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { findPurgeBlockers, purgeAccount, recordDataRequest } from "@/lib/personal-data";
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
 * Предпросмотр: что произойдёт при удалении. Нужен интерфейсу, чтобы человек
 * видел последствия (личные проекты уходят, командные требуют передачи) до
 * необратимого действия.
 */
export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return json(requestId, { ok: false, error: "unauthorized" }, 401);

  try {
    const pool = getPool();
    const [personal, blockers] = await Promise.all([
      pool.query<{ count: string | number }>(
        `select count(*)::int as count from projects where personal_owner_user_id = $1`,
        [user.id],
      ),
      findPurgeBlockers(pool, user.id),
    ]);
    return json(requestId, {
      ok: true,
      personalProjects: Number(personal.rows[0]?.count ?? 0),
      // Командные проекты, где пользователь единственный владелец: их нельзя
      // осиротить, поэтому удаление потребует передачи или отказа.
      blockers,
    });
  } catch (error) {
    console.error("[/api/settings/account-deletion]", {
      requestId,
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
    return json(requestId, { ok: false, error: "server" }, 500);
  }
}

/**
 * Удаление аккаунта (ст. 21 152-ФЗ).
 *
 * Физического `delete from users` быть не может: на пользователя ссылаются
 * десятки таблиц с запретом удаления (ревизии, решения редакции, журналы
 * публикаций), а каскад унёс бы чужие данные. Поэтому персональные данные
 * стираются, а идентификатор остаётся технической ссылкой без сведений о
 * человеке. Всё в одной транзакции: частично удалённый аккаунт не восстановить.
 */
export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req, { requireBrowserOrigin: true })) {
    return json(requestId, { ok: false, error: "forbidden" }, 403);
  }
  const user = await getSessionUser(req);
  if (!user) return json(requestId, { ok: false, error: "unauthorized" }, 401);

  const rate = await checkRateLimit(`settings:account-deletion:${user.id}`, 3, 3600);
  if (!rate.allowed) return rateLimitResponse(rate);

  let body: unknown;
  try {
    body = await readJsonBodyValue(req, BODY_MAX_BYTES);
  } catch {
    return json(requestId, { ok: false, error: "bad_request" }, 400);
  }
  const data = (body ?? {}) as Record<string, unknown>;
  if (data.confirm !== true) {
    return json(requestId, { ok: false, error: "confirm_required" }, 422);
  }
  const transferSharedTo = Number.isInteger(data.transferSharedTo) ? Number(data.transferSharedTo) : null;

  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1, $2)", [74, user.id]);
    const result = await purgeAccount(client, user.id, { transferSharedTo });
    if (!result.ok) {
      await client.query("rollback");
      return json(
        requestId,
        {
          ok: false,
          error: result.error,
          // Интерфейс покажет эти проекты и предложит передать их участнику.
          projects: result.projects,
        },
        409,
      );
    }
    await recordDataRequest(client, {
      userId: user.id,
      kind: "deletion",
      state: "completed",
      result: {
        deletedPersonalProjects: result.deletedPersonalProjects,
        transferredSharedProjects: result.transferredSharedProjects,
        ip: clientIp(req),
      },
    });
    await client.query("commit");
    return json(requestId, {
      ok: true,
      deleted: true,
      deletedPersonalProjects: result.deletedPersonalProjects,
      transferredSharedProjects: result.transferredSharedProjects,
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.error("[/api/settings/account-deletion]", {
      requestId,
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
    return json(requestId, { ok: false, error: "server" }, 500);
  } finally {
    client.release();
  }
}
