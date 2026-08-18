import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { migrate } from "../../scripts/migrate.mjs";
import {
  cancelPublicationOperation,
  reschedulePublicationOperation,
  restorePublicationDraft,
} from "@/lib/publication-lifecycle.mjs";
import { reconcilePublicationOutbox } from "@/lib/publication-outbox.mjs";
import { beginProviderCall, claimPublicationLease } from "../../worker/publication-lease.mjs";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
  || target.pathname.slice(1) !== "aurora_publication_gate_test") {
  throw new Error("Publication lifecycle integration requires disposable local aurora_publication_gate_test database");
}

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 12 });
let userId = 0;
let otherUserId = 0;
let projectId = 0;
let otherProjectId = 0;
let channelId = 0;

async function createOperation(suffix: string, postCount = 1) {
  const scheduledAt = new Date(Date.now() + 10_000);
  const fingerprint = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
  const operation = (await pool.query(
    `insert into publication_operations
       (project_id, user_id, draft_version, idempotency_key, fingerprint, text, scheduled_at,
        timezone, destination_ids, status)
     values ($1, $2, 1, $3, $4, $5, $6, 'UTC', $7::jsonb, 'queued')
     returning id, schedule_revision`,
    [
      projectId,
      userId,
      `lifecycle:${suffix}`,
      fingerprint,
      `Lifecycle ${suffix}`,
      scheduledAt,
      JSON.stringify([channelId]),
    ],
  )).rows[0];
  const postIds: number[] = [];
  for (let index = 0; index < postCount; index += 1) {
    const post = (await pool.query(
      `insert into posts
         (project_id, user_id, channel_id, text, scheduled_at, status, publication_origin,
          publication_operation_id, publication_draft_version)
       values ($1, $2, $3, $4, $5, 'scheduled', 'manual', $6, 1)
       returning id`,
      [projectId, userId, channelId, `Lifecycle ${suffix} ${index}`, scheduledAt, operation.id],
    )).rows[0];
    postIds.push(Number(post.id));
    await pool.query(
      `insert into publication_outbox (operation_id, post_id, status, enqueued_at)
       values ($1, $2, 'enqueued', now())`,
      [operation.id, post.id],
    );
  }
  return {
    operationId: Number(operation.id),
    postIds,
    revision: Number(operation.schedule_revision),
  };
}

function cancelInput(operationId: number, revision = 1, key = crypto.randomUUID()) {
  return {
    pool,
    userId,
    projectId,
    operationId,
    expectedRevision: revision,
    expectedStatus: "queued",
    idempotencyKey: key,
    requestId: `qa-${key}`,
  };
}

async function claim(postId: number, revision = 1, leaseToken = crypto.randomUUID()) {
  return {
    leaseToken,
    post: await claimPublicationLease(pool, {
      postId,
      projectId,
      scheduleRevision: revision,
      leaseToken,
      overdueCutoff: new Date(Date.now() - 5 * 60_000),
    }),
  };
}

beforeAll(async () => {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
  userId = Number((await pool.query(
    "insert into users (email, name) values ('qa-lifecycle@example.test', 'QA Lifecycle') returning id",
  )).rows[0].id);
  otherUserId = Number((await pool.query(
    "insert into users (email, name) values ('qa-lifecycle-other@example.test', 'QA Other') returning id",
  )).rows[0].id);
  projectId = Number((await pool.query(
    `insert into projects (name, timezone, created_by_user_id, personal_owner_user_id)
     values ('Lifecycle project', 'UTC', $1, $1) returning id`,
    [userId],
  )).rows[0].id);
  otherProjectId = Number((await pool.query(
    `insert into projects (name, timezone, created_by_user_id, personal_owner_user_id)
     values ('Other project', 'UTC', $1, $1) returning id`,
    [otherUserId],
  )).rows[0].id);
  await pool.query(
    `insert into project_members (project_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')`,
    [projectId, userId, otherProjectId, otherUserId],
  );
  await pool.query(
    `insert into user_project_preferences (user_id, selected_project_id) values ($1, $2), ($3, $4)`,
    [userId, projectId, otherUserId, otherProjectId],
  );
  channelId = Number((await pool.query(
    `insert into channels (project_id, user_id, network, tg_chat_id, title, handle, is_active)
     values ($1, $2, 'tg', -100910000031, 'Lifecycle', 'qa_lifecycle', true) returning id`,
    [projectId, userId],
  )).rows[0].id);
});

afterAll(async () => { await pool.end(); });

describe("publication lifecycle revision fencing", () => {
  it("cancels before worker claim and makes the stale job inert", async () => {
    const fixture = await createOperation("cancel-before-claim");
    const result = await cancelPublicationOperation(cancelInput(fixture.operationId));
    expect(result).toMatchObject({ ok: true, status: "cancelled", scheduleRevision: 2 });
    expect(await claimPublicationLease(pool, {
      postId: fixture.postIds[0],
      projectId,
      scheduleRevision: 1,
      leaseToken: "stale-before-claim",
      overdueCutoff: new Date(Date.now() - 5 * 60_000),
    })).toBeNull();
  });

  it("cancels after BullMQ delivery but before DB lease", async () => {
    const fixture = await createOperation("job-before-lease");
    const receivedJob = { postId: fixture.postIds[0], scheduleRevision: fixture.revision };
    const result = await cancelPublicationOperation(cancelInput(fixture.operationId));
    expect(result.ok).toBe(true);
    expect(await claimPublicationLease(pool, {
      ...receivedJob,
      projectId,
      leaseToken: "job-before-lease",
      overdueCutoff: new Date(Date.now() - 5 * 60_000),
    })).toBeNull();
  });

  it("lets cancellation fence a claimed lease before the provider call", async () => {
    const fixture = await createOperation("cancel-after-lease");
    const leased = await claim(fixture.postIds[0]);
    expect(leased.post).not.toBeNull();
    const cancelled = await cancelPublicationOperation(cancelInput(fixture.operationId));
    expect(cancelled.ok).toBe(true);
    expect(await beginProviderCall(pool, {
      postId: fixture.postIds[0],
      projectId,
      scheduleRevision: 1,
      leaseToken: leased.leaseToken,
    })).toBe(false);
  });

  it("returns publication_in_progress once provider delivery started", async () => {
    const fixture = await createOperation("cancel-provider-started");
    const leased = await claim(fixture.postIds[0]);
    expect(await beginProviderCall(pool, {
      postId: fixture.postIds[0],
      projectId,
      scheduleRevision: 1,
      leaseToken: leased.leaseToken,
    })).toBe(true);
    const cancelled = await cancelPublicationOperation(cancelInput(fixture.operationId));
    expect(cancelled).toMatchObject({ ok: false, error: "publication_in_progress", httpStatus: 409 });
  });

  it("reschedules to a new revision and ignores the old delayed job", async () => {
    const fixture = await createOperation("reschedule-old-job");
    const result = await reschedulePublicationOperation({
      ...cancelInput(fixture.operationId),
      scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      timezone: "UTC",
      offset: "+00:00",
      disambiguation: "reject",
    });
    expect(result).toMatchObject({ ok: true, status: "scheduled", scheduleRevision: 2 });
    expect(await claimPublicationLease(pool, {
      postId: fixture.postIds[0],
      projectId,
      scheduleRevision: 1,
      leaseToken: "old-delayed-job",
      overdueCutoff: new Date(Date.now() - 5 * 60_000),
    })).toBeNull();
    const post = (await pool.query(
      "select status, schedule_revision from posts where id = $1",
      [fixture.postIds[0]],
    )).rows[0];
    expect(post).toMatchObject({ status: "scheduled", schedule_revision: "2" });
  });

  it("linearizes parallel cancel and reschedule mutations", async () => {
    const fixture = await createOperation("parallel-mutations");
    const [cancelled, rescheduled] = await Promise.all([
      cancelPublicationOperation(cancelInput(fixture.operationId, 1, "parallel-cancel")),
      reschedulePublicationOperation({
        ...cancelInput(fixture.operationId, 1, "parallel-reschedule"),
        scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        timezone: "UTC",
        offset: "+00:00",
        disambiguation: "reject",
      }),
    ]);
    expect([cancelled, rescheduled].filter((result) => result.ok)).toHaveLength(1);
    expect([cancelled, rescheduled].find((result) => !result.ok)?.error)
      .toBe("schedule_revision_conflict");
  });

  it("does not resurrect a committed cancellation during restart reconciliation", async () => {
    const fixture = await createOperation("cancel-restart");
    await cancelPublicationOperation(cancelInput(fixture.operationId));
    const enqueue = vi.fn();
    const reconciliation = await reconcilePublicationOutbox({
      pool,
      enqueue,
      operationId: fixture.operationId,
    });
    expect(reconciliation.enqueued).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    const state = (await pool.query(
      `select operation.status as operation_status, post.status as post_status,
              outbox.status as outbox_status
         from publication_operations operation
         join posts post on post.publication_operation_id = operation.id
         join publication_outbox outbox on outbox.post_id = post.id
        where operation.id = $1`,
      [fixture.operationId],
    )).rows[0];
    expect(state).toMatchObject({
      operation_status: "cancelled",
      post_status: "cancelled",
      outbox_status: "cancelled",
    });
  });

  it("restores one idempotent editable draft and keeps owner scoping", async () => {
    const fixture = await createOperation("restore-draft");
    const key = "restore-draft-key";
    const first = await restorePublicationDraft({
      ...cancelInput(fixture.operationId, 1, key),
    });
    const replay = await restorePublicationDraft({
      ...cancelInput(fixture.operationId, 1, key),
    });
    expect(first).toMatchObject({ ok: true, draftVersion: 1, replayed: false });
    expect(replay).toMatchObject({ ok: true, draftId: first.draftId, replayed: true });
    expect((await pool.query(
      "select count(*)::int as count from drafts where id = $1 and user_id = $2 and project_id = $3",
      [first.draftId, userId, projectId],
    )).rows[0].count).toBe(1);
    const foreign = await restorePublicationDraft({
      ...cancelInput(fixture.operationId, 1, "foreign-restore"),
      userId: otherUserId,
    });
    expect(foreign).toMatchObject({ ok: false, error: "publication_operation_not_found", httpStatus: 404 });
    const wrongProject = await restorePublicationDraft({
      ...cancelInput(fixture.operationId, 1, "cross-project-restore"),
      projectId: otherProjectId,
    });
    expect(wrongProject).toMatchObject({ ok: false, error: "publication_operation_not_found", httpStatus: 404 });
  });
});
