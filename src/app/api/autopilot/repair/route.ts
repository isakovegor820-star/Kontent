import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { resolveChannel } from "@/lib/autopilot";
import { autopilotRetryableItemIndexes } from "@/lib/autopilot-build-progress.mjs";
import { isAutopilotReaderReadyItem } from "@/lib/autopilot-review.mjs";
import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { getAutopilotQueue } from "@/lib/queue";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import {
  AUTOPILOT_JOB_ATTEMPTS,
  AUTOPILOT_JOB_BACKOFF_MS,
} from "@/lib/autopilot-config.mjs";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_REPAIR_BODY_BYTES = 8 * 1024;
const REPAIR_KEYS = new Set(["planId", "revision", "channelId", "jobId", "itemIndexes"]);

async function readRepairBody(req: NextRequest) {
  if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return null;
  }
  try {
    const bytes = await readRequestBodyLimited(req.body, MAX_REPAIR_BODY_BYTES);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const body = value as Record<string, unknown>;
    return Object.keys(body).every((key) => REPAIR_KEYS.has(key)) ? body : null;
  } catch (error) {
    if (error instanceof BoundedBodyError || error instanceof SyntaxError) return null;
    throw error;
  }
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function requestedIndexes(value: unknown) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 90) return undefined;
  const indexes = [...new Set(value.map(Number))];
  return indexes.every((index) => Number.isSafeInteger(index) && index >= 0)
    ? indexes.sort((left, right) => left - right)
    : undefined;
}

function repairRequestHash(
  projectId: number,
  channelId: number,
  planId: number,
  revision: number,
  indexes: number[],
) {
  return createHash("sha256")
    .update(JSON.stringify({ projectId, channelId, planId, revision, indexes }), "utf8")
    .digest("hex");
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  try {
    const raw = await readRepairBody(req);
    const planId = positiveInteger(raw?.planId);
    const revision = positiveInteger(raw?.revision);
    const channelInput = positiveInteger(raw?.channelId);
    const jobId = typeof raw?.jobId === "string" && UUID.test(raw.jobId) ? raw.jobId.toLowerCase() : null;
    const selectedIndexes = requestedIndexes(raw?.itemIndexes);
    if (!planId || !revision || !channelInput || !jobId || selectedIndexes === undefined) {
      return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
    }

    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.create");
    const projectId = membership.projectId;
    const channelId = await resolveChannel(
      { actorUserId: user.id, projectId },
      channelInput,
    );
    if (!channelId) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

    const tx = await pool.connect();
    let operationId: number | null = null;
    let indexes: number[] = [];
    let nextRevision = revision;
    let replay: { status: string; operationId: number } | null = null;
    try {
      await tx.query("begin");
      const preexisting = (
        await tx.query(
          `select id, source_plan_id, channel_id, base_revision, item_indexes,
                  request_hash, status
             from autopilot_repair_operations
            where project_id = $1 and job_id = $2::uuid
            for update`,
          [projectId, jobId],
        )
      ).rows[0];
      if (preexisting) {
        const storedIndexes = Array.isArray(preexisting.item_indexes)
          ? preexisting.item_indexes.map(Number)
          : [];
        const matchesRequest = Number(preexisting.source_plan_id) === planId &&
          Number(preexisting.channel_id) === channelId &&
          Number(preexisting.base_revision) === revision &&
          (selectedIndexes == null || JSON.stringify(selectedIndexes) === JSON.stringify(storedIndexes)) &&
          preexisting.request_hash === repairRequestHash(
            projectId,
            channelId,
            planId,
            revision,
            storedIndexes,
          );
        if (!matchesRequest) {
          await tx.query("rollback");
          return NextResponse.json({ ok: false, error: "idempotency_conflict" }, { status: 409 });
        }
        replay = { status: String(preexisting.status), operationId: Number(preexisting.id) };
        await tx.query("commit");
      }
      if (replay) {
        // The source plan may already have been atomically replaced and deleted. The durable
        // operation identity is sufficient to replay the original result safely.
      } else {
      const plan = (
        await tx.query(
          `select id, revision, status, items, repair_strategy, repair_attempt,
                  expected_post_count, publication_target_count, build_report
             from autopilot_plan
            where id = $1 and project_id = $2 and channel_id = $3
              and status in ('partial', 'error', 'building')
            for update`,
          [planId, projectId, channelId],
        )
      ).rows[0];
      if (!plan) {
        await tx.query("rollback");
        return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
      }

      const items = Array.isArray(plan.items) ? plan.items : [];
      const readyCount = items.filter(isAutopilotReaderReadyItem).length;
      const publicationTargetCount = Math.max(
        1,
        Number(plan.publication_target_count || plan.expected_post_count) || 1,
      );
      const selectionDeficit = Math.max(
        1,
        Number(plan.build_report?.selectionDeficit) || publicationTargetCount - readyCount,
      );
      const available = autopilotRetryableItemIndexes(items).sort((left, right) =>
        Number(Boolean(items[right]?.news)) - Number(Boolean(items[left]?.news)),
      );
      indexes = (selectedIndexes == null
        ? available
        : selectedIndexes.filter((index) => available.includes(index)))
        .slice(0, selectionDeficit);
      if (!indexes.length) {
        await tx.query("rollback");
        return NextResponse.json({ ok: false, error: "nothing_to_repair" }, { status: 409 });
      }
      const requestHash = repairRequestHash(projectId, channelId, planId, revision, indexes);

      const existing = (
        await tx.query(
          `select id, request_hash, status
             from autopilot_repair_operations
            where project_id = $1 and job_id = $2::uuid
            for update`,
          [projectId, jobId],
        )
      ).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) {
          await tx.query("rollback");
          return NextResponse.json({ ok: false, error: "idempotency_conflict" }, { status: 409 });
        }
        replay = { status: String(existing.status), operationId: Number(existing.id) };
        await tx.query("commit");
      } else {
        if (Number(plan.revision) !== revision || plan.status === "building") {
          await tx.query("rollback");
          return NextResponse.json({ ok: false, error: "revision_conflict" }, { status: 409 });
        }
        const running = await tx.query(
          `select id from autopilot_repair_operations
            where plan_id = $1 and project_id = $2 and status in ('queued', 'processing')
            limit 1`,
          [planId, projectId],
        );
        if (running.rowCount) {
          await tx.query("rollback");
          return NextResponse.json({ ok: false, error: "repair_in_progress" }, { status: 409 });
        }
        const attemptNumber = Math.max(1, Number(plan.repair_attempt || 0) + 1);
        const inserted = await tx.query(
          `insert into autopilot_repair_operations
             (project_id, user_id, channel_id, source_plan_id, plan_id, job_id, request_hash,
              base_revision, item_indexes, repair_strategy, attempt_number, status)
           values ($1, $2, $3, $4, $4, $5::uuid, $6, $7, $8::jsonb, $9, $10, 'queued')
           returning id`,
          [
            projectId,
            user.id,
            channelId,
            planId,
            jobId,
            requestHash,
            revision,
            JSON.stringify(indexes),
            plan.repair_strategy,
            attemptNumber,
          ],
        );
        operationId = Number(inserted.rows[0].id);
        const claimed = await tx.query(
          `update autopilot_plan
              set status = 'building', repair_attempt = $5,
                  last_repair_job_id = $4::uuid, terminal_outcome = null,
                  build_activity_at = now(), revision = revision + 1
            where id = $1 and project_id = $2 and channel_id = $3 and revision = $6
            returning revision`,
          [planId, projectId, channelId, jobId, attemptNumber, revision],
        );
        if (!claimed.rowCount) throw new Error("repair revision claim failed");
        nextRevision = Number(claimed.rows[0].revision);
        await tx.query("commit");
      }
      }
    } catch (error) {
      await tx.query("rollback").catch(() => {});
      throw error;
    } finally {
      tx.release();
    }

    if (replay) {
      if (replay.status === "failed") {
        return NextResponse.json({
          ok: false,
          replayed: true,
          error: "repair_failed",
          operationId: replay.operationId,
          planId,
        }, { status: 503 });
      }
      return NextResponse.json({
        ok: true,
        replayed: true,
        status: replay.status,
        operationId: replay.operationId,
        planId,
      });
    }
    if (!operationId) throw new Error("repair operation was not created");

    const queue = getAutopilotQueue();
    if ((await queue.getWorkersCount()) === 0) {
      await pool.query(
        `update autopilot_repair_operations
            set status = 'failed', terminal_outcome = 'worker_unavailable',
                diagnostic = '{"code":"worker_unavailable"}'::jsonb,
                completed_at = now(), updated_at = now()
          where id = $1 and project_id = $2 and status = 'queued'`,
        [operationId, projectId],
      );
      await pool.query(
        `update autopilot_plan set status = 'partial', revision = revision + 1
          where id = $1 and project_id = $2 and channel_id = $3
            and status = 'building' and last_repair_job_id = $4::uuid`,
        [planId, projectId, channelId, jobId],
      );
      return NextResponse.json({ ok: false, error: "worker_unavailable" }, { status: 503 });
    }

    try {
      await queue.add(
        "autopilot-repair",
        { projectId, userId: user.id, channelId, planId, operationId, repairIndexes: indexes },
        {
          jobId: `autopilot-repair-${projectId}-${jobId}`,
          removeOnComplete: true,
          attempts: AUTOPILOT_JOB_ATTEMPTS,
          backoff: { type: "fixed", delay: AUTOPILOT_JOB_BACKOFF_MS },
        },
      );
    } catch {
      await pool.query(
        `update autopilot_repair_operations
            set status = 'failed', terminal_outcome = 'queue_unavailable',
                diagnostic = '{"code":"queue_unavailable"}'::jsonb,
                completed_at = now(), updated_at = now()
          where id = $1 and project_id = $2 and status = 'queued'`,
        [operationId, projectId],
      ).catch(() => {});
      await pool.query(
        `update autopilot_plan set status = 'partial', revision = revision + 1
          where id = $1 and project_id = $2 and channel_id = $3
            and status = 'building' and last_repair_job_id = $4::uuid`,
        [planId, projectId, channelId, jobId],
      ).catch(() => {});
      return NextResponse.json({ ok: false, error: "queue_unavailable" }, { status: 503 });
    }

    return NextResponse.json({
      ok: true,
      planId,
      revision: nextRevision,
      operationId,
      itemIndexes: indexes,
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/autopilot/repair]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
