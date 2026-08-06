import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  add: vi.fn(),
  getSessionUser: vi.fn(),
  probePublication: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getPool: () => ({ query: mocks.query, connect: mocks.connect }),
}));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/readiness-probes", () => ({
  probeRedisAndPublicationWorker: mocks.probePublication,
}));
vi.mock("@/lib/queue", () => ({
  getPublishQueue: () => ({ add: mocks.add }),
  jobIdForPostRevision: (postId: number | string, revision: number | string) =>
    `post-${postId}-r${revision}`,
}));

import { POST } from "./route";

type PersistedPost = {
  id: string;
  idempotency_key: string;
  request_fingerprint: string;
  scheduled_at: string;
  status: string;
};

function request(text: string, scheduledAt: string, draftVersion = 3) {
  return new NextRequest("http://localhost/api/posts/create", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      draftId: 41,
      draftVersion,
      channelId: 11,
      text,
      scheduledAt,
      media: null,
    }),
  });
}

describe("POST /api/posts/create draft destination outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
    mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
    mocks.add.mockResolvedValue({ id: "post-501" });
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  });

  it("fails before database writes when no publication worker is alive", async () => {
    mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "down" });

    const response = await POST(
      request("Не должен зависнуть", new Date(Date.now() + 3_600_000).toISOString()),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "publication_worker_unavailable",
      retryable: true,
    });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("reuses a successful destination after the remaining draft text and date changed", async () => {
    let persisted: PersistedPost | null = null;
    const insertCalls: unknown[][] = [];
    const firstDate = new Date(Date.now() + 3_600_000).toISOString();
    const secondDate = new Date(Date.now() + 7_200_000).toISOString();
    let draftRead = 0;
    mocks.query.mockImplementation(async (sqlValue: string, params: unknown[] = []) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.startsWith("select id from channels")) {
        return { rowCount: 1, rows: [{ id: 11 }] };
      }
      if (sql.startsWith("select d.id, d.text")) {
        draftRead += 1;
        return {
          rowCount: 1,
          rows: [{
            id: 41,
            text: draftRead === 1 ? "Первая ревизия" : "Текст изменён после partial failure",
            scheduled_at: draftRead === 1 ? firstDate : secondDate,
            origin: "manual",
            purpose: "publishable",
            generation_result_id: null,
            generation_result_hash: null,
            receipt_result_hash: null,
            receipt_payload: null,
            version: draftRead === 1 ? "3" : "4",
            review_policy_version: "1",
            ai_validation: null,
            human_reviewed_version: null,
            human_reviewed_at: null,
          }],
        };
      }
      if (sql.startsWith("insert into posts")) {
        insertCalls.push(params);
        if (persisted) return { rowCount: 0, rows: [] };
        persisted = {
          id: "501",
          idempotency_key: String(params[5]),
          request_fingerprint: String(params[6]),
          scheduled_at: String(params[4]),
          status: "scheduled",
        };
        return {
          rowCount: 1,
          rows: [{ id: persisted.id, request_fingerprint: persisted.request_fingerprint }],
        };
      }
      if (sql.startsWith("select id, idempotency_key")) {
        return { rowCount: persisted ? 1 : 0, rows: persisted ? [persisted] : [] };
      }
      return { rowCount: 0, rows: [] };
    });

    const firstResponse = await POST(request("Первая ревизия", firstDate, 3));
    const secondResponse = await POST(request("Текст изменён после partial failure", secondDate, 4));

    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toMatchObject({
      ok: true,
      postId: 501,
      scheduledAt: firstDate,
      replayed: false,
    });
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      ok: true,
      postId: 501,
      scheduledAt: firstDate,
      replayed: true,
    });

    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0]?.[2]).toBe("Первая ревизия");
    expect(insertCalls[1]?.[2]).toBe("Текст изменён после partial failure");
    expect(insertCalls[0]?.[5]).toBe("draft:41:destination:11");
    expect(insertCalls[1]?.[5]).toBe("draft:41:destination:11");
    expect(mocks.add).toHaveBeenCalledTimes(2);
    expect(mocks.add).toHaveBeenNthCalledWith(
      2,
      "publish",
      { postId: 501, scheduleRevision: 1 },
      expect.objectContaining({ jobId: "post-501-r1" }),
    );
    const statements = mocks.query.mock.calls.map(([sql]) =>
      String(sql).replace(/\s+/g, " ").trim().toLowerCase()
    );
    const begin = statements.indexOf("begin");
    const lockedDraft = statements.findIndex((sql) =>
      sql.startsWith("select d.id, d.text") && sql.includes("for update of d")
    );
    const insertedPost = statements.findIndex((sql) => sql.startsWith("insert into posts"));
    const commit = statements.indexOf("commit");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lockedDraft).toBeGreaterThan(begin);
    expect(insertedPost).toBeGreaterThan(lockedDraft);
    expect(commit).toBeGreaterThan(insertedPost);
    expect(mocks.release).toHaveBeenCalledTimes(2);
  });

  it("does not persist an outcome for a draft destination outside the authenticated account", async () => {
    mocks.query.mockImplementation(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.startsWith("select id from channels")) {
        return { rowCount: 1, rows: [{ id: 11 }] };
      }
      if (sql.startsWith("select d.id, d.text")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });

    const response = await POST(request("Чужой черновик", new Date(Date.now() + 3_600_000).toISOString()));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "bad_draft_destination" });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("insert into posts"))).toBe(false);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a blocked validation",
      aiValidation: {
        version: 1,
        status: "blocked",
        requiresReview: false,
        blockerCodes: ["unsupported_claim"],
        provenance: {
          validatorVersion: "fact-ledger-v1",
          ledgerHash: "fl1-1234abcd",
          checkedAt: "2026-08-01T11:55:00.000Z",
          coverage: "deterministic",
          semanticEntailment: "not_checked",
          rulesRun: ["unsupported_claim"],
          sourceIds: ["brief:1"],
        },
      },
      humanReviewVersion: null,
      expected: "ai_draft_blocked",
    },
    {
      label: "missing validation and no human ACK",
      aiValidation: null,
      humanReviewVersion: null,
      expected: "ai_draft_review_required",
    },
    {
      label: "a human ACK from an older version",
      aiValidation: null,
      humanReviewVersion: 2,
      expected: "ai_draft_review_required",
    },
  ])("fails closed for AI drafts with $label", async ({ aiValidation, humanReviewVersion, expected }) => {
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    mocks.query.mockImplementation(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.startsWith("select id from channels")) {
        return { rowCount: 1, rows: [{ id: 11 }] };
      }
      if (sql.startsWith("select d.id, d.text")) {
        return {
          rowCount: 1,
          rows: [{
            id: 41,
            text: "AI-текст",
            scheduled_at: scheduledAt,
            origin: "ai",
            purpose: "needs_review",
            generation_result_id: "81",
            generation_result_hash: null,
            receipt_result_hash: null,
            receipt_payload: null,
            version: "3",
            review_policy_version: "1",
            ai_validation: aiValidation,
            human_reviewed_version: humanReviewVersion,
            human_reviewed_at:
              humanReviewVersion == null ? null : "2026-08-01T12:05:00.000Z",
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const response = await POST(request("AI-текст", scheduledAt, 3));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ ok: false, error: expected });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("insert into posts"))).toBe(false);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("allows an AI draft only after a human ACK bound to the current version", async () => {
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    mocks.query.mockImplementation(async (sqlValue: string, params: unknown[] = []) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.startsWith("select id from channels")) {
        return { rowCount: 1, rows: [{ id: 11 }] };
      }
      if (sql.startsWith("select d.id, d.text")) {
        return {
          rowCount: 1,
          rows: [{
            id: 41,
            text: "Проверенный AI-текст",
            scheduled_at: scheduledAt,
            origin: "ai",
            purpose: "needs_review",
            generation_result_id: "81",
            generation_result_hash: null,
            receipt_result_hash: null,
            receipt_payload: null,
            version: "3",
            review_policy_version: "1",
            ai_validation: null,
            human_reviewed_version: "3",
            human_reviewed_at: "2026-08-01T12:05:00.000Z",
          }],
        };
      }
      if (sql.startsWith("insert into posts")) {
        return { rowCount: 1, rows: [{ id: "501", request_fingerprint: String(params[6]) }] };
      }
      return { rowCount: 0, rows: [] };
    });

    const response = await POST(request("Проверенный AI-текст", scheduledAt, 3));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, postId: 501, replayed: false });
    expect(mocks.add).toHaveBeenCalledOnce();
  });

  it("rejects a stale client draft version before publication", async () => {
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    mocks.query.mockImplementation(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.startsWith("select id from channels")) {
        return { rowCount: 1, rows: [{ id: 11 }] };
      }
      if (sql.startsWith("select d.id, d.text")) {
        return {
          rowCount: 1,
          rows: [{
            id: 41,
            text: "Серверная версия",
            scheduled_at: scheduledAt,
            origin: "manual",
            purpose: "publishable",
            generation_result_id: null,
            generation_result_hash: null,
            receipt_result_hash: null,
            receipt_payload: null,
            version: "4",
            review_policy_version: "1",
            ai_validation: null,
            human_reviewed_version: null,
            human_reviewed_at: null,
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const response = await POST(request("Серверная версия", scheduledAt, 3));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "draft_version_conflict",
      currentVersion: 4,
    });
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
