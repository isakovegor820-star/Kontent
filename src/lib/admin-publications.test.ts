import { describe, expect, it, vi } from "vitest";

import {
  cancelAdminPublication,
  normalizeAdminPublicationsQuery,
  rescheduleAdminPublication,
  retryAdminPublication,
} from "./admin-publications";

type Row = { status: string; in_flight: boolean; project_id?: number };

function fakePool(row: Row | null, options: { failQueue?: boolean } = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sqlValue: string, params: unknown[] = []) => {
    const sql = sqlValue.replace(/\s+/gu, " ").trim();
    statements.push({ sql, params });
    if (sql.startsWith("select status, publish_lease_token is not null as in_flight")) {
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    if (sql.startsWith("update posts set status = 'scheduled'")) {
      return { rowCount: 1, rows: [{ id: params[0], project_id: row?.project_id ?? 23, schedule_revision: 4 }] };
    }
    return { rowCount: 1, rows: [] };
  });
  const release = vi.fn();
  const pool = { query, connect: vi.fn(async () => ({ query, release })) } as never as Parameters<typeof retryAdminPublication>[0];
  const add: (name: string, data: Record<string, unknown>, jobOptions?: Record<string, unknown>) => Promise<unknown> = async () => {
    if (options.failQueue) throw new Error("redis down");
    return { id: "job" };
  };
  const queue = { add: vi.fn(add) };
  return { pool, queue, query, release, statements };
}

describe("admin publications query normalisation", () => {
  it("falls back to safe defaults and bounds every filter", () => {
    expect(normalizeAdminPublicationsQuery(new URLSearchParams(""))).toEqual({
      query: "", status: "attention", network: "all", projectId: null, errorCode: "", sort: "recent", page: 1, pageSize: 25,
    });
    expect(normalizeAdminPublicationsQuery(new URLSearchParams("status=hacked&network=vk;drop&error=Bad%20Code&sort=x&page=-3&project=12")))
      .toEqual({ query: "", status: "attention", network: "all", projectId: 12, errorCode: "", sort: "recent", page: 1, pageSize: 25 });
    expect(normalizeAdminPublicationsQuery(new URLSearchParams("q=4302&status=failed&network=tg&error=vk_token_expired&sort=attempts_desc&page=3")))
      .toMatchObject({ query: "4302", status: "failed", network: "tg", errorCode: "vk_token_expired", sort: "attempts_desc", page: 3 });
  });
});

describe("admin publication actions", () => {
  it("retries a confirmed failure immediately with a bumped revision, audit row and queue job", async () => {
    const { pool, queue, statements } = fakePool({ status: "failed", in_flight: false, project_id: 23 });
    const result = await retryAdminPublication(pool, queue, { actorUserId: 3, postId: 42, requestId: "req-1" });
    expect(result).toMatchObject({ status: "queued", postId: 42, scheduleRevision: 4 });
    const sqls = statements.map((entry) => entry.sql);
    expect(sqls[0]).toBe("begin");
    expect(sqls.at(-1)).toBe("commit");
    const update = statements.find((entry) => entry.sql.startsWith("update posts set status = 'scheduled'"));
    expect(update?.sql).toContain("schedule_revision = schedule_revision + 1");
    expect(update?.sql).toContain("quarantined_at = null");
    expect(update?.sql).toContain("where id = $1 and publish_lease_token is null");
    const audit = statements.find((entry) => entry.sql.startsWith("insert into audit_events"));
    expect(audit?.params).toEqual([23, 3, "publication.admin.retried", "42", expect.stringContaining('"from":"failed"'), "req-1"]);
    expect(queue.add).toHaveBeenCalledWith(
      "publish",
      { postId: 42, projectId: 23, scheduleRevision: 4 },
      expect.objectContaining({ jobId: "post-42-r4", delay: 0 }),
    );
  });

  it("never touches a publication whose provider call is in flight", async () => {
    const { pool, queue, statements } = fakePool({ status: "scheduled", in_flight: true, project_id: 23 });
    await expect(retryAdminPublication(pool, queue, { actorUserId: 3, postId: 42 })).resolves.toEqual({ status: "in_progress" });
    await expect(cancelAdminPublication(pool, { actorUserId: 3, postId: 42 })).resolves.toEqual({ status: "in_progress" });
    expect(statements.some((entry) => entry.sql.startsWith("update posts"))).toBe(false);
    expect(statements.filter((entry) => entry.sql === "rollback")).toHaveLength(2);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("refuses statuses outside the allowed transitions and reports the current one", async () => {
    const { pool, queue } = fakePool({ status: "published", in_flight: false, project_id: 23 });
    await expect(retryAdminPublication(pool, queue, { actorUserId: 3, postId: 42 })).resolves.toEqual({ status: "not_allowed", currentStatus: "published" });
    await expect(cancelAdminPublication(pool, { actorUserId: 3, postId: 42 })).resolves.toEqual({ status: "not_allowed", currentStatus: "published" });
    const missing = fakePool(null);
    await expect(retryAdminPublication(missing.pool, missing.queue, { actorUserId: 3, postId: 42 })).resolves.toEqual({ status: "not_found" });
  });

  it("compensates the database when the queue rejects the job", async () => {
    const { pool, queue, statements } = fakePool({ status: "quarantined", in_flight: false, project_id: 23 }, { failQueue: true });
    await expect(retryAdminPublication(pool, queue, { actorUserId: 3, postId: 42 })).resolves.toEqual({ status: "queue_unavailable" });
    const compensation = statements.find((entry) => entry.sql.includes("Очередь публикаций недоступна"));
    expect(compensation?.params).toEqual([42, 4, "quarantined"]);
  });

  it("reschedules only inside a sane window and keeps the requested time", async () => {
    const { pool, queue } = fakePool({ status: "quarantined", in_flight: false, project_id: 23 });
    await expect(rescheduleAdminPublication(pool, queue, { actorUserId: 3, postId: 42, scheduledAt: "not-a-date" })).resolves.toEqual({ status: "invalid_time" });
    await expect(rescheduleAdminPublication(pool, queue, { actorUserId: 3, postId: 42, scheduledAt: "2020-01-01T00:00:00.000Z" })).resolves.toEqual({ status: "invalid_time" });
    const inTwoHours = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const result = await rescheduleAdminPublication(pool, queue, { actorUserId: 3, postId: 42, scheduledAt: inTwoHours });
    expect(result).toMatchObject({ status: "queued", scheduledAt: inTwoHours });
    const jobOptions = queue.add.mock.calls[0][2] as { delay: number };
    expect(jobOptions.delay).toBeGreaterThan(3_500_000);
  });

  it("cancels pending publications with a bumped revision and an audit trail", async () => {
    const { pool, statements } = fakePool({ status: "failed_retry", in_flight: false, project_id: 23 });
    await expect(cancelAdminPublication(pool, { actorUserId: 3, postId: 42, reason: "Клиент попросил", requestId: "req-2" })).resolves.toEqual({ status: "cancelled", postId: 42 });
    const update = statements.find((entry) => entry.sql.startsWith("update posts set status = 'cancelled'"));
    expect(update?.sql).toContain("schedule_revision = schedule_revision + 1");
    const audit = statements.find((entry) => entry.sql.startsWith("insert into audit_events"));
    expect(audit?.params[2]).toBe("publication.admin.cancelled");
    expect(String(audit?.params[4])).toContain('"reason":"Клиент попросил"');
    expect(statements.at(-1)?.sql).toBe("commit");
  });
});
