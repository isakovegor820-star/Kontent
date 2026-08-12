import { describe, expect, it, vi } from "vitest";

import {
  enqueuePublicationReviewReminderJob,
  markDuePublicationReviews,
  processPublicationReviewReminderJob,
  publicationReviewReminderJobKey,
  reconcilePublicationReviewReminderOutbox,
  recoverAmbiguousPublicationReviewReminders,
} from "./publication-review-reminder.mjs";

describe("publication review reminder outbox", () => {
  it("creates one durable UI notification and deterministic outbox identity", async () => {
    const query = vi.fn(async (sql) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
      if (sql.includes("update publication_review_tasks task") && sql.includes("returning task.id")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("select task.id")) return { rows: [{
        id: "5", project_id: "7", post_id: "11", responsible_user_id: "13",
        review_at: "2026-10-25T01:30:00.000Z", timezone: "Europe/Amsterdam",
        version: "4", channel_id: "17", title: "Практика",
      }], rowCount: 1 };
      if (sql.includes("set status = 'due'")) return { rows: [{ version: "5" }], rowCount: 1 };
      if (sql.includes("insert into project_notifications")) return { rows: [], rowCount: 1 };
      if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
      if (sql.includes("insert into publication_review_reminder_outbox")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() })) };
    await expect(markDuePublicationReviews({ pool })).resolves.toEqual({ due: 1, cancelled: 0 });
    const notificationSql = String(query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into project_notifications"))?.[0]);
    expect(notificationSql).toContain("'/app/calendar'");
    expect(notificationSql).toContain("review_task_id");
    expect(notificationSql).toContain("$3::text");
    expect(notificationSql).toContain("($3::text)::bigint");
    const outboxCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into publication_review_reminder_outbox"));
    expect(outboxCall?.[1]?.[3]).toBe(publicationReviewReminderJobKey({
      projectId: "7", reviewTaskId: "5", recipientUserId: "13",
    }));
    expect(String(query.mock.calls.find(([sql]) => String(sql).includes("select task.id"))?.[0]))
      .toContain("post.status = 'published'");
  });

  it("rebuilds a missing BullMQ job with the same job id", async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes("where status = 'dispatching'")) return { rows: [], rowCount: 0 };
      if (sql.includes("where status = 'enqueued'")) return { rows: [], rowCount: 0 };
      if (sql.includes("select outbox.id")) return { rows: [{
        id: "3", project_id: "7", review_task_id: "5", recipient_user_id: "13",
        job_key: "a".repeat(64),
      }], rowCount: 1 };
      if (sql.includes("set status = 'dispatching'")) return { rows: [], rowCount: 1 };
      if (sql.includes("set status = 'enqueued'")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const enqueue = vi.fn(async () => undefined);
    await expect(reconcilePublicationReviewReminderOutbox({ pool: { query }, enqueue }))
      .resolves.toEqual({ candidates: 1, enqueued: 1, failed: 0 });
    expect(enqueue).toHaveBeenCalledWith({
      projectId: 7, reviewTaskId: 5, recipientUserId: 13, jobKey: "a".repeat(64),
    });
    const queue = { add: vi.fn(async () => ({ id: "a".repeat(64) })) };
    await enqueuePublicationReviewReminderJob(enqueue.mock.calls[0][0], queue);
    expect(queue.add).toHaveBeenCalledWith("deliver", expect.anything(), expect.objectContaining({
      jobId: "a".repeat(64), attempts: 1,
    }));
  });

  it("performs one provider call and treats a replay as completed", async () => {
    let completed = false;
    const transactionQuery = vi.fn(async (sql) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
      if (sql.includes("select task.id")) return { rows: [{
        id: "5", project_id: "7", responsible_user_id: "13", reminder_status: "pending",
        status: "due", post_status: "published", is_active: true, channel_status: "active",
        title: "Практика", is_archived: false, member_status: "active", tg_chat_id: "100",
        outbox_status: completed ? "completed" : "enqueued", job_key: "b".repeat(64),
      }], rowCount: 1 };
      if (sql.includes("reminder_status = 'sending'")) return { rows: [], rowCount: 1 };
      if (sql.includes("set status = 'running'")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const poolQuery = vi.fn(async (sql) => {
      if (sql.includes("with task_result")) {
        completed = true;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected pool query: ${sql}`);
    });
    const pool = {
      connect: vi.fn(async () => ({ query: transactionQuery, release: vi.fn() })),
      query: poolQuery,
    };
    const notifyUser = vi.fn(async () => true);
    const data = { projectId: 7, reviewTaskId: 5, recipientUserId: 13, jobKey: "b".repeat(64) };
    await expect(processPublicationReviewReminderJob({ pool, notifyUser, data }))
      .resolves.toEqual({ status: "sent" });
    await expect(processPublicationReviewReminderJob({ pool, notifyUser, data }))
      .resolves.toEqual({ status: "skipped", reason: "completed" });
    expect(notifyUser).toHaveBeenCalledOnce();
  });

  it("closes an ambiguous provider-started attempt without retrying it", async () => {
    const query = vi.fn(async (sql) => {
      expect(sql).toContain("reminder_provider_started_at");
      expect(sql).toContain("delivery_unknown");
      return { rows: [], rowCount: 1 };
    });
    await expect(recoverAmbiguousPublicationReviewReminders({ pool: { query } }))
      .resolves.toEqual({ recovered: 1 });
  });
});
