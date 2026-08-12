// Д.3 — создание поста. Сохраняем со статусом scheduled и кладём ОТЛОЖЕННУЮ задачу
// в очередь: задержка = сколько осталось до scheduled_at. Дальше пост живёт в очереди
// на сервере — компьютер пользователя больше не нужен.

import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getPublishQueue, jobIdForPostRevision } from "@/lib/queue";
import {
  draftDestinationIdempotencyKey,
  normalizeIdempotencyKey,
  publicationFingerprint,
} from "@/lib/publication-idempotency";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { draftReviewDecision } from "@/lib/draft-review";
import type { DraftHumanReview } from "@/lib/draft-types";
import { generationBindingValid } from "@/lib/generation-artifacts";
import { probeRedisAndPublicationWorker } from "@/lib/readiness-probes";
import {
  ProjectAccessError,
  requireSelectedProjectPermission,
} from "@/lib/project-permissions";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: {
    channelId?: unknown;
    text?: unknown;
    scheduledAt?: unknown;
    media?: unknown;
    idempotencyKey?: unknown;
    draftId?: unknown;
    draftVersion?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const channelId = Number(body.channelId);
  const text = String(body.text ?? "").trim();
  const scheduledAtRaw = body.scheduledAt ? new Date(String(body.scheduledAt)) : null;
  const draftId = body.draftId == null ? null : Number(body.draftId);
  const draftVersion = body.draftVersion == null ? null : Number(body.draftVersion);
  const providedIdempotencyKey = normalizeIdempotencyKey(
    req.headers.get("idempotency-key") ?? body.idempotencyKey,
  );

  if (!Number.isSafeInteger(channelId) || channelId <= 0) {
    return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
  }
  if (!text) {
    return NextResponse.json({ ok: false, error: "empty_text" }, { status: 422 });
  }
  if (!scheduledAtRaw || Number.isNaN(scheduledAtRaw.getTime())) {
    return NextResponse.json({ ok: false, error: "no_time" }, { status: 422 });
  }
  if (draftId != null && (!Number.isSafeInteger(draftId) || draftId <= 0)) {
    return NextResponse.json({ ok: false, error: "bad_draft" }, { status: 422 });
  }
  if (
    draftId != null &&
    (draftVersion == null || !Number.isSafeInteger(draftVersion) || draftVersion <= 0)
  ) {
    return NextResponse.json({ ok: false, error: "bad_draft_version" }, { status: 422 });
  }
  // Для Composer сервер сам выводит operation key из устойчивых id. Случайный ключ
  // браузера остаётся только для вызовов, не связанных с серверным черновиком.
  const idempotencyKey = draftId == null
    ? providedIdempotencyKey
    : draftDestinationIdempotencyKey(draftId, channelId);
  if (!idempotencyKey) {
    return NextResponse.json({ ok: false, error: "idempotency_key_required" }, { status: 400 });
  }
  if (scheduledAtRaw.getTime() < Date.now() - 60_000) {
    return NextResponse.json({ ok: false, error: "past" }, { status: 422 });
  }

  let tx: PoolClient | null = null;
  let txOpen = false;
  let publicationOrigin: "manual" | "ai" | "trend" | "idea" | "competitor" | "rss" | "autopilot" = "manual";
  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.publish");
    const projectId = membership.projectId;
    const publication = await probeRedisAndPublicationWorker();
    if (publication.redis !== "up" || publication.publicationWorker !== "up") {
      return NextResponse.json(
        { ok: false, error: "publication_worker_unavailable", retryable: true },
        { status: 503 },
      );
    }
    if (draftId != null) {
      tx = await pool.connect();
      await tx.query("begin");
      txOpen = true;
    }
    const db = tx ?? pool;
    const commitDraftTransaction = async () => {
      if (!txOpen || !tx) return;
      const client = tx;
      await client.query("commit");
      txOpen = false;
      client.release();
      tx = null;
    };

    // Destination is authorized by the selected project, not by the channel creator.
    const ch = await db.query<{ id: number }>(
      `select id from channels where id = $1 and project_id = $2 and is_active = true`,
      [channelId, projectId],
    );
    if (ch.rowCount === 0) {
      return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    }

    if (draftId != null) {
      const destination = await db.query<{
        id: number;
        text: string;
        scheduled_at: Date | string | null;
        origin: "manual" | "ai" | "trend" | "idea" | "competitor" | "rss" | "autopilot";
        purpose: "source_context" | "publishable" | "needs_review";
        generation_result_id: number | string | null;
        generation_result_hash: string | null;
        receipt_result_hash: string | null;
        receipt_payload: unknown;
        version: number | string;
        review_policy_version: number | string;
        ai_validation: unknown;
        human_reviewed_version: number | string | null;
        human_reviewed_at: Date | string | null;
      }>(
        `select d.id, d.text, d.scheduled_at, d.origin, d.purpose, d.version,
                d.generation_result_id, result.result_hash as generation_result_hash,
                receipt.result_hash as receipt_result_hash, receipt.receipt as receipt_payload,
                d.review_policy_version, d.ai_validation,
                d.human_reviewed_version, d.human_reviewed_at
          from drafts d
           left join generation_results result on result.id = d.generation_result_id
           left join validation_receipts receipt on receipt.generation_result_id = result.id
           join draft_destinations dd on dd.draft_id = d.id
          where d.id = $1 and d.project_id = $2 and dd.channel_id = $3
          for update of d`,
        [draftId, projectId, channelId],
      );
      if (destination.rowCount === 0) {
        return NextResponse.json({ ok: false, error: "bad_draft_destination" }, { status: 422 });
      }
      const draft = destination.rows[0];
      if (draft.purpose === "source_context") {
        return NextResponse.json({ ok: false, error: "source_context_not_publishable" }, { status: 422 });
      }
      publicationOrigin = draft.origin;
      const currentVersion = Number(draft.version);
      if (currentVersion !== draftVersion) {
        return NextResponse.json(
          { ok: false, error: "draft_version_conflict", currentVersion },
          { status: 409 },
        );
      }
      const persistedAt = draft.scheduled_at == null
        ? null
        : new Date(draft.scheduled_at).toISOString();
      if (draft.text !== text || persistedAt !== scheduledAtRaw.toISOString()) {
        return NextResponse.json(
          { ok: false, error: "draft_content_conflict", currentVersion },
          { status: 409 },
        );
      }

      const reviewedVersion = Number(draft.human_reviewed_version);
      const humanReview: DraftHumanReview | null =
        Number.isSafeInteger(reviewedVersion) &&
        reviewedVersion > 0 &&
        draft.human_reviewed_at != null
          ? {
              policy_version: 1,
              draft_version: reviewedVersion,
              attested_at: new Date(draft.human_reviewed_at).toISOString(),
            }
          : null;
      const review = draftReviewDecision({
        origin: draft.origin,
        purpose: draft.purpose,
        generation_result_id: draft.generation_result_id == null ? null : Number(draft.generation_result_id),
        generation_binding_valid: generationBindingValid({
          generationResultId: draft.generation_result_id,
          text: draft.text,
          resultHash: draft.generation_result_hash,
          receiptHash: draft.receipt_result_hash,
          aiValidation: draft.ai_validation,
          receipt: draft.receipt_payload,
        }),
        version: currentVersion,
        review_policy_version: Number(draft.review_policy_version),
        ai_validation: draft.ai_validation,
        human_review: humanReview,
      });
      if (review === "blocked") {
        return NextResponse.json({ ok: false, error: "ai_draft_blocked" }, { status: 422 });
      }
      if (review === "review_required") {
        return NextResponse.json(
          { ok: false, error: "ai_draft_review_required" },
          { status: 422 },
        );
      }
    }

    let media: string | null = null;
    if (body.media && typeof body.media === "object") {
      const candidate = body.media as { assetId?: unknown; kind?: unknown };
      const assetId = Number(candidate.assetId);
      if (Number.isInteger(assetId) && assetId > 0) {
        const owned = await db.query<{ id: number; kind: "image" | "video" }>(
          `select id, kind from media_assets where id = $1 and project_id = $2`,
          [assetId, projectId],
        );
        if (owned.rowCount === 0) {
          return NextResponse.json({ ok: false, error: "bad_media" }, { status: 422 });
        }
        media = JSON.stringify({ assetId, kind: owned.rows[0].kind });
      }
    }
    const requestedScheduledAt = scheduledAtRaw.toISOString();
    const fingerprint = publicationFingerprint({
      userId: user.id,
      channelId,
      text,
      scheduledAt: requestedScheduledAt,
      media,
    });
    const ins = await db.query<{
      id: string;
      request_fingerprint: string;
      schedule_revision: number | string;
    }>(
      `insert into posts (
         project_id, user_id, channel_id, text, media, scheduled_at, status,
         idempotency_key, request_fingerprint, publication_origin
       )
       values ($1, $2, $3, $4, $5, $6, 'scheduled', $7, $8, $9)
       on conflict do nothing
       returning id, request_fingerprint, schedule_revision`,
      [projectId, user.id, channelId, text, media, requestedScheduledAt, idempotencyKey, fingerprint, publicationOrigin],
    );
    const created = ins.rowCount === 1;
    let postId = Number(ins.rows[0]?.id);
    let scheduleRevision = Number(ins.rows[0]?.schedule_revision || 1);
    let effectiveScheduledAt = requestedScheduledAt;
    let effectiveScheduledAtRaw = scheduledAtRaw;
    if (!created) {
      const existing = (
        await db.query<{
          id: string;
          idempotency_key: string | null;
          request_fingerprint: string;
          scheduled_at: Date | string;
          status: string;
          schedule_revision: number | string;
        }>(
          `select id, idempotency_key, request_fingerprint, scheduled_at, status, schedule_revision
             from posts
            where project_id = $1 and user_id = $2
              and (idempotency_key = $3 or request_fingerprint = $4)
            order by case when idempotency_key = $3 then 0 else 1 end
            limit 1`,
          [projectId, user.id, idempotencyKey, fingerprint],
        )
      ).rows[0];
      const persistedDraftDestination =
        draftId != null && existing?.idempotency_key === idempotencyKey;
      if (
        !existing ||
        (draftId != null
          ? !persistedDraftDestination
          : existing.request_fingerprint !== fingerprint)
      ) {
        return NextResponse.json({ ok: false, error: "idempotency_conflict" }, { status: 409 });
      }
      postId = Number(existing.id);
      scheduleRevision = Number(existing.schedule_revision || 1);
      effectiveScheduledAtRaw = new Date(existing.scheduled_at);
      if (Number.isNaN(effectiveScheduledAtRaw.getTime())) {
        throw new Error("persisted post time missing");
      }
      effectiveScheduledAt = effectiveScheduledAtRaw.toISOString();
      if (existing.status !== "scheduled") {
        await commitDraftTransaction();
        return NextResponse.json(
          {
            ok: true,
            postId,
            scheduledAt: effectiveScheduledAt,
            replayed: true,
            status: existing.status,
          },
          { status: 200 },
        );
      }
    }
    if (!Number.isSafeInteger(postId) || postId <= 0) throw new Error("post id missing");

    // The row lock linearizes scheduling against PATCH/review in another tab. Commit the
    // durable post before touching Redis; a queue failure is compensated below.
    await commitDraftTransaction();

    // Отложенная задача: публиковать через (scheduled_at − сейчас).
    const delay = Math.max(0, effectiveScheduledAtRaw.getTime() - Date.now());
    try {
      await getPublishQueue().add(
        "publish",
        { postId, projectId, scheduleRevision },
        {
          delay,
          jobId: jobIdForPostRevision(postId, scheduleRevision),
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    } catch (error) {
      // PostgreSQL и Redis не умеют общую транзакцию. Компенсируем вставку, чтобы API
      // никогда не оставлял в календаре scheduled-пост без исполняемой job.
      if (created) {
        await pool.query(
          `delete from posts
            where id = $1 and project_id = $2
              and status = 'scheduled' and idempotency_key = $3`,
          [postId, projectId, idempotencyKey],
        ).catch(() => {});
      }
      throw error;
    }

    return NextResponse.json({
      ok: true,
      postId,
      scheduledAt: effectiveScheduledAt,
      replayed: !created,
    });
  } catch (err) {
    if (txOpen && tx) {
      await tx.query("rollback").catch(() => {});
      txOpen = false;
    }
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/posts/create]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  } finally {
    if (txOpen && tx) {
      await tx.query("rollback").catch(() => {});
    }
    tx?.release();
  }
}
