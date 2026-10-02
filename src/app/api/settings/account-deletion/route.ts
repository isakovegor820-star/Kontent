import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { findPurgeBlockers, findTransferCandidates, purgeAccount, recordDataRequest } from "@/lib/personal-data";
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
    // Кандидатов на передачу считает сервер: клиент не должен решать, кому
    // можно отдать проект, и не должен знать состав участников заранее.
    const transferableIds = blockers.filter((project) => project.hasOtherMembers).map((project) => project.id);
    const candidatesByProject: Record<number, Array<{ userId: number; name: string | null; role: string }>> = {};
    for (const projectId of transferableIds) {
      candidatesByProject[projectId] = await findTransferCandidates(pool, projectId, user.id);
    }
    // Один преемник должен подходить каждому проекту: оставляем тех, кто есть
    // во всех списках. Иначе интерфейс предложил бы выбор, который сервер
    // отклонит как неоднозначный.
    const commonCandidates = transferableIds.length
      ? (candidatesByProject[transferableIds[0]] ?? []).filter((candidate) =>
          transferableIds.every((projectId) =>
            (candidatesByProject[projectId] ?? []).some((item) => item.userId === candidate.userId),
          ),
        )
      : [];

    return json(requestId, {
      ok: true,
      personalProjects: Number(personal.rows[0]?.count ?? 0),
      // Проекты, где пользователь единственный владелец и есть кому передать:
      // без выбора преемника удаление невозможно.
      blockers: blockers.filter((project) => project.hasOtherMembers),
      // Проекты без других участников: уйдут вместе с аккаунтом.
      orphanedProjects: blockers.filter((project) => !project.hasOtherMembers),
      transferCandidates: commonCandidates,
      transferCandidatesByProject: candidatesByProject,
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
      // Разные причины — разные ответы: 409 когда нужна передача, 422 когда
      // выбрана неподходящая цель. Интерфейсу важно их различать.
      const status = result.error === "invalid_transfer_target" ? 422 : 409;
      return json(
        requestId,
        {
          ok: false,
          error: result.error,
          // Интерфейс покажет эти проекты и предложит передать их участнику.
          projects: result.projects,
        },
        status,
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
      // Командные проекты без других участников тоже уходят с аккаунтом:
      // передать их некому, а держать не для кого.
      deletedSharedProjects: result.deletedSharedProjects,
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
