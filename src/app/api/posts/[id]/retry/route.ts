// Д.3 — ручная повторная отправка поста (кнопка «Отправить снова» после сбоя).
// Возвращаем пост в очередь на публикацию сейчас; статус снова scheduled.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getPublishQueue, jobIdForPostRevision } from "@/lib/queue";
import { normalizeIdempotencyKey, retryJobSuffix } from "@/lib/publication-idempotency";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import {
  ProjectAccessError,
  requireSelectedProjectPermission,
} from "@/lib/project-permissions";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const postId = Number(id);
  if (!Number.isSafeInteger(postId) || postId <= 0) {
    return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });
  }
  const idempotencyKey = normalizeIdempotencyKey(req.headers.get("idempotency-key"));
  if (!idempotencyKey) {
    return NextResponse.json({ ok: false, error: "idempotency_key_required" }, { status: 400 });
  }

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.publish");
    const projectId = membership.projectId;
    // Повтор допустим только после подтверждённого failure. `publishing` и
    // `published_unverified` означают неизвестный внешний результат: повтор там может
    // создать дубль и должен начинаться с reconciliation.
    const retryAt = new Date(Date.now() + 2 * 60_000);
    const upd = await pool.query<{
      id: string;
      schedule_revision: number | string;
      scheduled_at: Date | string;
    }>(
      `update posts
          set status = 'scheduled', last_error = null,
              last_retry_key = $3, retry_requested_at = now(),
              scheduled_at = $4, next_attempt_at = null,
              quarantined_at = null, quarantine_reason = null,
              publication_origin = 'retry', schedule_revision = schedule_revision + 1,
              provider_operation_id = null, provider_reconciliation_state = 'none',
              provider_reconciliation_requested_at = null
        where id = $1 and project_id = $2 and status in ('failed', 'quarantined')
        returning id, schedule_revision, scheduled_at`,
      [postId, projectId, idempotencyKey, retryAt],
    );
    if (upd.rowCount === 0) {
      const current = (
        await pool.query<{ status: string; last_retry_key: string | null }>(
          `select status, last_retry_key from posts where id = $1 and project_id = $2`,
          [postId, projectId],
        )
      ).rows[0];
      if (current?.last_retry_key === idempotencyKey) {
        return NextResponse.json({ ok: true, replayed: true });
      }
      return NextResponse.json({ ok: false, error: "not_retryable" }, { status: 422 });
    }

    const scheduleRevision = Number(upd.rows[0].schedule_revision);

    try {
      await getPublishQueue().add(
        "publish",
        { postId, projectId, scheduleRevision },
        {
          delay: Math.max(0, retryAt.getTime() - Date.now()),
          jobId: `${jobIdForPostRevision(postId, scheduleRevision)}-manual-${retryJobSuffix(idempotencyKey)}`,
          removeOnComplete: true,
        },
      );
    } catch (error) {
      // Retry без job опаснее явного failed: пользователь видит проблему и может повторить,
      // а не ждёт публикацию, которой в очереди нет.
      await pool.query(
        `update posts
            set status = 'failed', last_error = 'Не удалось поставить повтор в очередь — попробуй ещё раз',
                last_retry_key = null
          where id = $1 and project_id = $2 and status = 'scheduled'
            and schedule_revision = $4 and last_retry_key = $3`,
        [postId, projectId, idempotencyKey, scheduleRevision],
      ).catch(() => {});
      throw error;
    }
    return NextResponse.json({
      ok: true,
      scheduledAt: retryAt.toISOString(),
      scheduleRevision,
    });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/posts/:id/retry]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
