// Д.9 — действие над одним постом плана: одобрить / отклонить / поправить текст.
// Правка сбрасывает streak (значит план не идеален — полный режим пока рано).

import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { enqueueAutopilotPost, resolveChannel } from "@/lib/autopilot";
import { getPublishQueue, jobIdForPost } from "@/lib/queue";
import { normalizePostQuality, type QualityResult } from "@/lib/post-quality.mjs";
import { assessAutopilotDraft } from "@/lib/autopilot-quality.mjs";
import {
  annotateAutopilotItems,
  attestAutopilotItemForHumanApproval,
  evaluateAutopilotItem,
  type ApprovalBlocker,
} from "@/lib/autopilot-approval.mjs";
import {
  abortAutopilotApproval,
  claimAutopilotPlan,
  finalizeAutopilotApproval,
  reclaimStaleAutopilotApprovals,
  resolvedAutopilotPlanStatus,
  scheduleAutopilotItem,
} from "@/lib/autopilot-scheduling.mjs";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import {
  ProjectAccessError,
  requireProjectPermission,
  requireSelectedProjectPermission,
} from "@/lib/project-permissions";

export const runtime = "nodejs";

interface PlanItem {
  i: number;
  scheduledAt: string;
  topic: string;
  draft: string;
  status: string;
  postId?: number;
  sources?: { id: number; text: string }[];
  invented?: string[];
  cited?: number | null;
  qualityBlocked?: boolean;
  quality?: QualityResult;
  qualityOrigin?: "automatic" | "human_attested";
  approvalBlockers?: ApprovalBlocker[];
}

const validKey = (value: unknown) => {
  const key = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:-]{8,128}$/.test(key) ? key : null;
};

function projectIdempotencyKey(projectId: number, clientKey: string): string {
  const prefix = `project:${projectId}:`;
  if (prefix.length + clientKey.length <= 128) return `${prefix}${clientKey}`;
  return `${prefix}sha256:${createHash("sha256").update(clientKey).digest("hex")}`;
}

async function finishApprovalOperation(
  id: number,
  projectId: number,
  userId: number,
  status: "completed" | "partial" | "failed",
  result: Record<string, unknown>,
  httpStatus: number,
) {
  await getPool().query(
    `update autopilot_approval_operations
        set status = $4, result = $5, http_status = $6, completed_at = now()
      where id = $1 and project_id = $2 and user_id = $3`,
    [id, projectId, userId, status, JSON.stringify(result), httpStatus],
  );
}

export async function PATCH(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: {
    index?: unknown;
    action?: unknown;
    draft?: unknown;
    channelId?: unknown;
    planId?: unknown;
    planRevision?: unknown;
    itemId?: unknown;
    idempotencyKey?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const index = Number(body.index);
  const requestedPlanId = Number(body.planId);
  const requestedRevision = Number(body.planRevision);
  const itemId = Number(body.itemId);
  const action = String(body.action);
  if (
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(itemId) || itemId !== index ||
    !Number.isSafeInteger(requestedPlanId) || requestedPlanId <= 0 ||
    !Number.isSafeInteger(requestedRevision) || requestedRevision <= 0 ||
    !["approve", "reject", "edit"].includes(action)
  ) {
    return NextResponse.json({ ok: false, error: "bad_action" }, { status: 422 });
  }

  let claimedApproval: {
    planId: number;
    projectId: number;
    userId: number;
    channelId: number;
    operationId: number;
  } | null = null;
  try {
    const pool = getPool();
    const permission = action === "edit" ? "content.edit" : "content.publish";
    const membership = await requireSelectedProjectPermission(pool, user.id, permission);
    const projectId = membership.projectId;
    const channelId = await resolveChannel(
      { actorUserId: user.id, projectId },
      Number(body.channelId) || null,
    );
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    await reclaimStaleAutopilotApprovals(pool, { projectId, channelId });

    // План ищем в пределах канала: иначе, открыв план канала Б, человек правил бы более
    // свежий план канала А — тот же список на экране, чужие посты в базе.
    const plan = (
      await pool.query<{ id: number; items: PlanItem[]; channel_id: number; status: string; revision: number }>(
        `select id, items, channel_id, status, revision from autopilot_plan
          where project_id = $1 and channel_id = $2 and id = $3 and revision = $4
            and status in ('pending', 'approved')`,
        [projectId, channelId, requestedPlanId, requestedRevision],
      )
    ).rows[0];
    if (!plan) return NextResponse.json({ ok: false, error: "stale_plan" }, { status: 409 });

    const items = plan.items;
    const it = items.find((x) => x.i === index);
    if (!it) return NextResponse.json({ ok: false, error: "no_item" }, { status: 404 });
    if (action === "edit" && it.postId) {
      await requireProjectPermission(pool, user.id, projectId, "content.publish");
    }

    if (action === "approve") {
      const idempotencyKey = validKey(body.idempotencyKey);
      if (!idempotencyKey) {
        return NextResponse.json({ ok: false, error: "bad_confirmation" }, { status: 422 });
      }
      const scopedIdempotencyKey = projectIdempotencyKey(projectId, idempotencyKey);

      const replay = (
        await pool.query<{
          channel_id: number;
          plan_id: number | null;
          request_snapshot: { index?: number; planRevision?: number };
          result: Record<string, unknown> | null;
          http_status: number;
        }>(
          `select channel_id, plan_id, request_snapshot, result, http_status
             from autopilot_approval_operations
            where project_id = $1 and user_id = $2 and idempotency_key = $3`,
          [projectId, user.id, scopedIdempotencyKey],
        )
      ).rows[0];
      if (replay) {
        if (
          Number(replay.channel_id) !== Number(plan.channel_id) ||
          Number(replay.plan_id) !== Number(plan.id) ||
          Number(replay.request_snapshot?.index) !== index ||
          Number(replay.request_snapshot?.planRevision) !== requestedRevision
        ) {
          return NextResponse.json({ ok: false, error: "idempotency_conflict" }, { status: 409 });
        }
        if (replay.result) {
          return NextResponse.json(replay.result, { status: replay.http_status });
        }
        return NextResponse.json({ ok: false, error: "approval_in_progress" }, { status: 409 });
      }

      const operation = await pool.query<{ id: number }>(
        `insert into autopilot_approval_operations
           (project_id, user_id, channel_id, plan_id, idempotency_key, actor_type, status, request_snapshot)
         values ($1, $2, $3, $4, $5, 'web', 'processing', $6)
         on conflict do nothing
         returning id`,
        [
          projectId,
          user.id,
          plan.channel_id,
          plan.id,
          scopedIdempotencyKey,
          JSON.stringify({
            channelId: plan.channel_id,
            planId: plan.id,
            planRevision: requestedRevision,
            index,
          }),
        ],
      );
      if (!operation.rowCount) {
        return NextResponse.json({ ok: false, error: "approval_in_progress" }, { status: 409 });
      }
      const operationId = Number(operation.rows[0].id);

      // Serialize item approvals through the plan row. The exact user/channel predicate is
      // repeated here so a stale UI cannot claim another channel's plan by id.
      const claim = await claimAutopilotPlan(pool, {
        planId: plan.id,
        projectId,
        userId: user.id,
        channelId: plan.channel_id,
        operationId,
        allowedStatuses: ["pending", "approved"],
        expectedRevision: requestedRevision,
      }) as { items: PlanItem[]; channel_id: number } | null;
      if (!claim) {
        const result = { ok: false, error: "approval_in_progress", retryable: true };
        await finishApprovalOperation(operationId, projectId, user.id, "failed", result, 409);
        return NextResponse.json(result, { status: 409 });
      }
      const approvalContext = {
        planId: plan.id,
        projectId,
        userId: user.id,
        channelId: Number(plan.channel_id),
        operationId,
      };
      claimedApproval = approvalContext;

      const approvalTime = Date.now();
      const claimedItems = claim.items.map((entry) =>
        entry.i === index
          ? attestAutopilotItemForHumanApproval(entry, {
              userId: user.id,
              attestedAt: new Date(approvalTime).toISOString(),
            })
          : entry,
      );
      const claimedItem = claimedItems.find((entry) => entry.i === index);
      if (!claimedItem) {
        const result = { ok: false, error: "no_item" };
        await finalizeAutopilotApproval({
          pool,
          ...approvalContext,
          items: claimedItems,
          planStatus: resolvedAutopilotPlanStatus(claimedItems),
          operationStatus: "failed",
          result,
          httpStatus: 404,
        });
        claimedApproval = null;
        return NextResponse.json(result, { status: 404 });
      }

      const evaluation = evaluateAutopilotItem(claimedItem, approvalTime);
      const safeItems = annotateAutopilotItems(claimedItems, approvalTime) as PlanItem[];
      const safeItem = safeItems.find((entry) => entry.i === index)!;
      if (!evaluation.actionable) {
        const unresolved = safeItems.some(
          (entry) => entry.status === "pending" || entry.status === "expired",
        );
        const result = { ok: true, already: true, postId: safeItem.postId ?? null };
        await finalizeAutopilotApproval({
          pool,
          ...approvalContext,
          items: safeItems,
          planStatus: unresolved ? "pending" : "approved",
          operationStatus: "completed",
          result,
          httpStatus: 200,
        });
        claimedApproval = null;
        return NextResponse.json(result);
      }
      if (!evaluation.eligible || !evaluation.scheduledAt) {
        const nextStatus = safeItems.some(
          (entry) => entry.status === "pending" || entry.status === "expired",
        )
          ? "pending"
          : "approved";
        const result = {
          ok: false,
          error: "approval_blocked",
          status: safeItem.status,
          blockers: evaluation.blockers.map((entry) => entry.message),
          blockerDetails: evaluation.blockers,
        };
        await finalizeAutopilotApproval({
          pool,
          ...approvalContext,
          items: safeItems,
          planStatus: nextStatus,
          operationStatus: "completed",
          result,
          httpStatus: 422,
        });
        claimedApproval = null;
        return NextResponse.json(result, { status: 422 });
      }

      try {
        const checkpoint = await scheduleAutopilotItem({
          pool,
          enqueue: enqueueAutopilotPost,
          planId: plan.id,
          projectId,
          userId: user.id,
          channelId: Number(claim.channel_id),
          operationId,
          index,
          nowMs: approvalTime,
        });
        safeItem.postId = checkpoint.postId;
        safeItem.status = "approved";
        const unresolved = safeItems.some(
          (entry) => entry.status === "pending" || entry.status === "expired",
        );
        const result = {
          ok: true,
          postId: safeItem.postId,
          scheduledAt: checkpoint.scheduledAt,
          reconciliationPending: checkpoint.queuePending,
        };
        await finalizeAutopilotApproval({
          pool,
          ...approvalContext,
          items: safeItems,
          planStatus: unresolved ? "pending" : "approved",
          operationStatus: "completed",
          result,
          httpStatus: 200,
        });
        claimedApproval = null;
        return NextResponse.json(result);
      } catch (error) {
        const result = { ok: false, error: "queue_unavailable", retryable: true };
        await finalizeAutopilotApproval({
          pool,
          ...approvalContext,
          items: safeItems,
          planStatus: "pending",
          operationStatus: "failed",
          result,
          httpStatus: 503,
        });
        claimedApproval = null;
        console.error("[/api/autopilot/item] checkpoint", error);
        return NextResponse.json(result, { status: 503 });
      }
    }

    let edited = false;

    if (action === "reject") {
      // Уже одобренный (в очереди) пост: снимаем задачу и отменяем ещё не вышедший пост,
      // иначе «убранный» пост всё равно опубликуется (ревью Д.9).
      if (it.postId) {
        try {
          const job = await getPublishQueue().getJob(jobIdForPost(it.postId));
          if (job) await job.remove();
        } catch (error) {
          // Ошибка чтения Redis и ошибка remove одинаково означают, что отсутствие job
          // не подтверждено. Не трогаем ни posts, ни план: иначе вернём ложный success,
          // а отложенная задача позже всё равно опубликует пост.
          console.error("[/api/autopilot/item] cancel queue", error);
          return NextResponse.json(
            { ok: false, error: "cancel_unavailable", retryable: true },
            { status: 503 },
          );
        }

        const originalItems = JSON.stringify(items);
        const client = await pool.connect();
        try {
          await client.query("begin");
          const cancelled = await client.query<{ id: number }>(
            `delete from posts
              where id = $1 and project_id = $2 and channel_id = $3 and status = 'scheduled'
              returning id`,
            [it.postId, projectId, plan.channel_id],
          );
          if (cancelled.rowCount !== 1) {
            // Воркер мог уже перевести строку в publishing. Не называем такую гонку
            // отменой: транзакция возвращает план и posts в исходное состояние.
            await client.query("rollback");
            return NextResponse.json(
              { ok: false, error: "cancel_conflict", retryable: true },
              { status: 409 },
            );
          }

          it.status = "rejected";
          const saved = await client.query<{ id: number }>(
            `update autopilot_plan
                set items = $4::jsonb, revision = revision + 1
              where id = $1 and project_id = $2 and channel_id = $3
                and status in ('pending', 'approved') and items = $5::jsonb
                and revision = $6
              returning id`,
            [
              plan.id,
              projectId,
              plan.channel_id,
              JSON.stringify(items),
              originalItems,
              requestedRevision,
            ],
          );
          if (saved.rowCount !== 1) {
            await client.query("rollback");
            return NextResponse.json(
              { ok: false, error: "cancel_conflict", retryable: true },
              { status: 409 },
            );
          }
          await client.query("commit");
          return NextResponse.json({ ok: true });
        } catch (error) {
          try {
            await client.query("rollback");
          } catch {
            // Keep the original database error for the route-level handler.
          }
          throw error;
        } finally {
          client.release();
        }
      }
      it.status = "rejected";
    } else if (action === "edit") {
      const next = String(body.draft ?? "").trim();
      if (next && next !== it.draft) {
        it.draft = next;
        edited = true;
        const row = (
          await pool.query<{ quality: unknown }>(
            `select quality from content_brief where project_id = $1 and channel_id = $2
              order by updated_at desc, user_id limit 1`,
            [projectId, plan.channel_id],
          )
        ).rows[0];
        const quality = normalizePostQuality(row?.quality);
        const result = await assessAutopilotDraft({
          text: next,
          quality,
          topic: it.topic,
          sources: it.sources ?? [],
          citedShare: it.cited ?? null,
          trigger: "edit_recheck",
        });
        it.quality = result;
        it.qualityBlocked = !result.passed;
        // The user edited the text, but the resulting score is still produced solely by
        // the deterministic validator. Editing is not a human quality attestation.
        it.qualityOrigin = "automatic";
        // После ручной правки старый список «выдумано» уже не описывает новый текст.
        // Источники и остальные программные рамки при этом всё равно проверяются выше.
        it.invented = undefined;
        // Если пост уже одобрен и стоит в очереди — правим и сам запланированный пост,
        // иначе воркер опубликует старый текст (ревью Д.9).
      }
    }

    // Правку помечаем на плане (для честного streak при следующем «Одобрить всё»), а не глобально.
    if (!(action === "edit" && edited && it.postId)) {
      const saved = await pool.query<{ revision: number }>(
        `update autopilot_plan
            set items = $5::jsonb, edited = edited or $6, revision = revision + 1
          where id = $1 and project_id = $2 and channel_id = $3 and revision = $4
            and status in ('pending', 'approved')
          returning revision`,
        [plan.id, projectId, plan.channel_id, requestedRevision, JSON.stringify(items), edited],
      );
      if (saved.rowCount !== 1) {
        return NextResponse.json({ ok: false, error: "stale_plan" }, { status: 409 });
      }
      return NextResponse.json({ ok: true, revision: Number(saved.rows[0].revision) });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      if (action === "edit" && edited && it.postId) {
        const post = await client.query(
          `update posts set text = $4
            where id = $1 and project_id = $2 and channel_id = $3 and status = 'scheduled'
            returning id`,
          [it.postId, projectId, plan.channel_id, it.draft],
        );
        if (post.rowCount !== 1) {
          await client.query("rollback");
          return NextResponse.json({ ok: false, error: "edit_conflict" }, { status: 409 });
        }
      }
      const saved = await client.query<{ revision: number }>(
        `update autopilot_plan
            set items = $5::jsonb, edited = edited or $6, revision = revision + 1
          where id = $1 and project_id = $2 and channel_id = $3 and revision = $4
            and status in ('pending', 'approved')
          returning revision`,
        [plan.id, projectId, plan.channel_id, requestedRevision, JSON.stringify(items), edited],
      );
      if (saved.rowCount !== 1) {
        await client.query("rollback");
        return NextResponse.json({ ok: false, error: "stale_plan" }, { status: 409 });
      }
      await client.query("commit");
      return NextResponse.json({ ok: true, revision: Number(saved.rows[0].revision) });
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/autopilot/item]", err);
    if (claimedApproval) {
      await abortAutopilotApproval({
        pool: getPool(),
        ...claimedApproval,
        result: { ok: false, error: "server", retryable: true },
        httpStatus: 500,
      }).catch(() => {});
    }
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
