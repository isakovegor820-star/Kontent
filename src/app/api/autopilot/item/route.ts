// Действия над одним постом плана: заменить, отклонить или поправить текст.
// Одобрение всегда идёт через batch preview/confirm: один пост не может обойти проверку всего плана.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { resolveChannel } from "@/lib/autopilot";
import { getPublishQueue, jobIdForPost } from "@/lib/queue";
import { normalizePostQuality, type QualityResult } from "@/lib/post-quality.mjs";
import { assessAutopilotDraft } from "@/lib/autopilot-quality.mjs";
import { findAutopilotNearDuplicate } from "@/lib/autopilot-config.mjs";
import { isAutopilotReaderReadyItem } from "@/lib/autopilot-review.mjs";
import {
  type ApprovalBlocker,
  type AutopilotApprovalItem,
} from "@/lib/autopilot-approval.mjs";
import { reclaimStaleAutopilotApprovals } from "@/lib/autopilot-scheduling.mjs";
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
  draftId?: number;
  sources?: { id: number; text: string }[];
  invented?: string[];
  cited?: number | null;
  qualityBlocked?: boolean;
  quality?: QualityResult;
  qualityOrigin?: "automatic" | "human_attested";
  approvalBlockers?: ApprovalBlocker[];
  news?: unknown;
  candidateIndex?: number;
  replacementHistory?: number[];
  humanAttestation?: AutopilotApprovalItem["humanAttestation"];
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
    body = await readJsonBodyValue(req);
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
    !["approve", "reject", "edit", "replace"].includes(action)
  ) {
    return NextResponse.json({ ok: false, error: "bad_action" }, { status: 422 });
  }
  if (action === "approve") {
    return NextResponse.json(
      { ok: false, error: "plan_approval_required" },
      { status: 409 },
    );
  }

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
      await pool.query<{
        id: number;
        items: PlanItem[];
        channel_id: number;
        status: string;
        revision: number;
      }>(
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

    if (action === "replace") {
      if (it.postId || it.status !== "pending") {
        return NextResponse.json({ ok: false, error: "item_unavailable" }, { status: 409 });
      }
      const candidateRow = (
        await pool.query<{ candidate_items: PlanItem[] }>(
          `select candidate_items from autopilot_plan
            where id = $1 and project_id = $2 and channel_id = $3 and revision = $4
              and status = 'pending'`,
          [plan.id, projectId, plan.channel_id, requestedRevision],
        )
      ).rows[0];
      const candidates = Array.isArray(candidateRow?.candidate_items)
        ? candidateRow.candidate_items
        : [];
      const usedCandidateIndexes = new Set(
        items.map((entry) => Number(entry.candidateIndex ?? entry.i)),
      );
      const rejectedCandidateIndexes = new Set(
        items.flatMap((entry) => Array.isArray(entry.replacementHistory)
          ? entry.replacementHistory.map(Number)
          : []),
      );
      rejectedCandidateIndexes.add(Number(it.candidateIndex ?? it.i));
      const otherItems = items
        .filter((entry) => entry !== it)
        .map((entry) => ({ topic: entry.topic, draft: entry.draft }));
      const replacement = candidates
        .filter((candidate) => {
          const candidateIndex = Number(candidate.i);
          return Number.isSafeInteger(candidateIndex) &&
            !usedCandidateIndexes.has(candidateIndex) &&
            !rejectedCandidateIndexes.has(candidateIndex) &&
            isAutopilotReaderReadyItem(candidate) &&
            !findAutopilotNearDuplicate(candidate, otherItems);
        })
        .sort((left, right) =>
          Number(Boolean(right.news) === Boolean(it.news)) -
            Number(Boolean(left.news) === Boolean(it.news)) ||
          Number(right.quality?.score || 0) - Number(left.quality?.score || 0) ||
          Number(left.i) - Number(right.i),
        )[0];
      if (!replacement) {
        return NextResponse.json(
          { ok: false, error: "replacement_unavailable" },
          { status: 409 },
        );
      }

      const candidateIndex = Number(replacement.i);
      const replacementHistory = [
        ...(Array.isArray(it.replacementHistory) ? it.replacementHistory.map(Number) : []),
        Number(it.candidateIndex ?? it.i),
      ].filter((value, position, values) =>
        Number.isSafeInteger(value) && value >= 0 && values.indexOf(value) === position,
      );
      const nextItem: PlanItem = {
        ...replacement,
        i: it.i,
        candidateIndex,
        replacementHistory,
        scheduledAt: it.scheduledAt,
        status: "pending",
      };
      delete nextItem.postId;
      delete nextItem.draftId;
      delete nextItem.humanAttestation;
      delete nextItem.approvalBlockers;
      items.splice(items.indexOf(it), 1, nextItem);

      const saved = await pool.query<{ revision: number }>(
        `update autopilot_plan
            set items = $5::jsonb, edited = true, revision = revision + 1
          where id = $1 and project_id = $2 and channel_id = $3 and revision = $4
            and status = 'pending'
          returning revision`,
        [plan.id, projectId, plan.channel_id, requestedRevision, JSON.stringify(items)],
      );
      if (saved.rowCount !== 1) {
        return NextResponse.json({ ok: false, error: "stale_plan" }, { status: 409 });
      }
      return NextResponse.json({
        ok: true,
        revision: Number(saved.rows[0].revision),
        index,
        topic: nextItem.topic,
      });
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
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
