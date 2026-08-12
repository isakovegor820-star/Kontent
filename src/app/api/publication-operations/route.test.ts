import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  getSessionUser: vi.fn(),
  probePublication: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  requireCurrentDraftApproval: vi.fn(),
  reconcilePublicationOutbox: vi.fn(),
  recheckTypographyForPublication: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/readiness-probes", () => ({
  probeRedisAndPublicationWorker: mocks.probePublication,
}));
vi.mock("@/lib/project-permissions", async (original) => ({
  ...await original<typeof import("@/lib/project-permissions")>(),
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));
vi.mock("@/lib/editorial-approval", async (original) => ({
  ...await original<typeof import("@/lib/editorial-approval")>(),
  requireCurrentDraftApproval: mocks.requireCurrentDraftApproval,
}));
vi.mock("@/lib/publication-outbox.mjs", () => ({
  reconcilePublicationOutbox: mocks.reconcilePublicationOutbox,
}));
vi.mock("@/lib/typography-service", async (original) => ({
  ...await original<typeof import("@/lib/typography-service")>(),
  recheckTypographyForPublication: mocks.recheckTypographyForPublication,
}));

import { POST } from "./route";
import { EditorialValidationError } from "@/lib/editorial-approval";
import { ProjectAccessError } from "@/lib/project-permissions";

function request(origin?: string, overrides: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/publication-operations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({
      draftId: 41,
      draftVersion: 3,
      timezone: "Europe/Amsterdam",
      ...overrides,
    }),
  });
}

function approvedRevisionSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 3,
    text: "Проверенный материал",
    media: null,
    tracking: null,
    origin: "manual",
    purpose: "publishable",
    schedule: {
      scheduledAt: "2099-08-20T08:00:00.000Z",
      timezone: "Europe/Amsterdam",
      localDate: "2099-08-20",
      localTime: "10:00",
      offset: "+02:00",
      disambiguation: "reject",
    },
    channelIds: [12],
    publicationPreferences: {
      version: 0,
      selectedBlocks: [],
      firstCommentFallback: "skip",
      commentsMode: "provider_default",
      pinAfterPublish: false,
      reviewAt: null,
      reviewResponsibleUserId: null,
    },
    ...overrides,
  };
}

function mutableDraftSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "41",
    project_id: "23",
    user_id: "9",
    version: "3",
    text: "Текущая изменяемая версия",
    media: null,
    tracking: null,
    scheduled_at: null,
    scheduled_timezone: null,
    scheduled_local_date: null,
    scheduled_local_time: null,
    scheduled_offset: null,
    scheduled_disambiguation: null,
    origin: "manual",
    purpose: "publishable",
    generation_result_id: null,
    generation_result_hash: null,
    receipt_result_hash: null,
    receipt_payload: null,
    review_policy_version: "1",
    ai_validation: null,
    human_reviewed_version: null,
    human_reviewed_at: null,
    ...overrides,
  };
}

function approvedRevisionRow(overrides: Record<string, unknown> = {}) {
  return {
    draft_version: "3",
    content_hash: "a".repeat(64),
    snapshot: approvedRevisionSnapshot(),
    ...overrides,
  };
}

function blockedAiValidation() {
  return {
    version: 1,
    status: "blocked",
    requiresReview: true,
    blockerCodes: ["unsupported_claim"],
    provenance: {
      validatorVersion: "fact-ledger-v1",
      ledgerHash: "fl1-12345678",
      checkedAt: "2026-08-12T10:00:00.000Z",
      coverage: "deterministic+semantic",
      semanticEntailment: "blocked",
      rulesRun: ["claim-support"],
      sourceIds: [],
    },
  };
}

describe("POST /api/publication-operations readiness gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("APP_URL", "");
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 23, role: "publisher" });
    mocks.requireCurrentDraftApproval.mockResolvedValue({
      revisionId: 91,
      contentHash: "a".repeat(64),
    });
    mocks.reconcilePublicationOutbox.mockResolvedValue({ statuses: { 91: "queued" } });
    mocks.recheckTypographyForPublication.mockResolvedValue({
      rulesVersion: "aurora-ru-typographer-v2",
      dictionaryVersion: 4,
      textHash: "b".repeat(64),
      status: "clean",
      suggestionCount: 0,
      reviewRunId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects an untrusted origin before session and authorization", async () => {
    const response = await POST(request("https://evil.example"));

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.requireSelectedProjectPermission).not.toHaveBeenCalled();
  });

  it.each([
    { redis: "up", publicationWorker: "down" },
    { redis: "down", publicationWorker: "down" },
    { redis: "not_configured", publicationWorker: "not_configured" },
  ])("keeps the draft untouched when publication is unavailable: %o", async (readiness) => {
    const pool = { connect: vi.fn() };
    mocks.getPool.mockReturnValue(pool);
    mocks.probePublication.mockResolvedValue(readiness);

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      result: "worker_unavailable",
      error: "publication_worker_unavailable",
      retryable: true,
    });
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(pool, 5, "content.publish");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects an author before readiness or publication work", async () => {
    const pool = { connect: vi.fn() };
    mocks.getPool.mockReturnValue(pool);
    mocks.requireSelectedProjectPermission.mockRejectedValue(
      new ProjectAccessError("permission_denied"),
    );

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden" });
    expect(mocks.probePublication).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each(["missing", "stale"])(
    "fails closed when the exact editorial approval is %s",
    async () => {
      mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
      mocks.requireCurrentDraftApproval.mockRejectedValue(
        new EditorialValidationError("approval_required"),
      );
      const scheduledAt = new Date(Date.now() + 60 * 60_000).toISOString();
      const client = {
        query: vi.fn(async (sql: string, _params?: unknown[]) => {
          void _params;
          if (sql === "begin" || sql === "rollback") return { rows: [] };
          if (sql.includes("from publication_operations")) return { rows: [] };
          if (sql.includes("from drafts d")) {
            return {
              rows: [{
                id: "41",
                project_id: "23",
                user_id: "9",
                version: "3",
                text: "Approved only after an exact review",
                media: null,
                scheduled_at: scheduledAt,
                scheduled_timezone: "Europe/Amsterdam",
                scheduled_local_date: "2026-08-20",
                scheduled_local_time: "10:00",
                scheduled_offset: "+02:00",
                scheduled_disambiguation: "reject",
                origin: "manual",
                purpose: "publishable",
                generation_result_id: null,
                generation_result_hash: null,
                receipt_result_hash: null,
                receipt_payload: null,
                review_policy_version: "1",
                ai_validation: null,
                human_reviewed_version: null,
                human_reviewed_at: null,
              }],
            };
          }
          throw new Error(`unexpected query: ${sql}`);
        }),
        release: vi.fn(),
      };
      mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await POST(request());

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ error: "approval_required" });
      expect(mocks.requireCurrentDraftApproval).toHaveBeenCalledWith(client, 5, 23, 41);
      const snapshotCall = client.query.mock.calls.find(([sql]) => String(sql).includes("from drafts d"));
      const replayCall = client.query.mock.calls.find(([sql]) => String(sql).includes("pg_advisory_xact_lock"));
      expect(replayCall).toBeTruthy();
      expect(String(snapshotCall?.[0])).toContain("d.project_id = $2");
      expect(snapshotCall?.[1]).toEqual([41, 23]);
      expect(client.query).toHaveBeenCalledWith("rollback");
      expect(client.release).toHaveBeenCalledOnce();
      errorLog.mockRestore();
    },
  );

  it("persists an explicit project and the exact approved revision snapshot", async () => {
    mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
    const tx = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === "begin" || sql === "commit") return { rows: [], rowCount: null };
        if (sql.includes("from publication_operations") && sql.includes("idempotency_key")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("from drafts d")) {
          return {
            rows: [{
              id: "41",
              project_id: "23",
              user_id: "9",
              version: "3",
                text: "НЕОДОБРЕННАЯ поздняя правка черновика",
                media: null,
                tracking: {
                  shortLinkId: 17,
                  shortUrlPath: "/r/abcdefghijklmnopqrst",
                  destination: "https://example.test/consultation?utm_source=vk&utm_campaign=bankruptcy_august",
                  utmValues: { utm_source: "vk", utm_campaign: "bankruptcy_august" },
                  placement: "cta",
                },
              scheduled_at: "2099-08-20T08:00:00.000Z",
              scheduled_timezone: "Europe/Amsterdam",
              scheduled_local_date: "2099-08-20",
              scheduled_local_time: "10:00",
              scheduled_offset: "+02:00",
              scheduled_disambiguation: "reject",
              origin: "manual",
              purpose: "publishable",
              generation_result_id: null,
              generation_result_hash: null,
              receipt_result_hash: null,
              receipt_payload: null,
              review_policy_version: "1",
              ai_validation: null,
              human_reviewed_version: null,
              human_reviewed_at: null,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("from draft_revisions revision")) {
          return {
            rows: [approvedRevisionRow({
              snapshot: approvedRevisionSnapshot({
                tracking: {
                  shortLinkId: 17,
                  shortUrlPath: "/r/abcdefghijklmnopqrst",
                  destination: "https://example.test/consultation?utm_source=vk&utm_campaign=bankruptcy_august",
                  utmValues: { utm_source: "vk", utm_campaign: "bankruptcy_august" },
                  placement: "cta",
                },
              }),
            })],
            rowCount: 1,
          };
        }
        if (sql.includes("approved_revision_id = $3")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("from channels channel")) {
          return { rows: [{ channel_id: "12", network: "vk" }], rowCount: 1 };
        }
        if (sql.includes("from short_links")) {
          return {
            rows: [{
              slug: "abcdefghijklmnopqrst",
              destination_url: "https://example.test/consultation?utm_source=vk&utm_campaign=bankruptcy_august",
              utm_values: { utm_source: "vk", utm_campaign: "bankruptcy_august" },
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("insert into publication_operations")) {
          return {
            rows: [{
              id: "91",
              project_id: "23",
              draft_id: "41",
              draft_version: "3",
              fingerprint: params?.[5],
              status: "pending",
              scheduled_at: "2099-08-20T08:00:00.000Z",
              timezone: "Europe/Amsterdam",
              schedule_offset: "+02:00",
              schedule_disambiguation: "reject",
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("insert into posts")) {
          return { rows: [{ id: "81", schedule_revision: "1" }], rowCount: 1 };
        }
        if (sql.startsWith("update monthly_campaign_items item")) {
          return { rows: [{ id: "701" }], rowCount: 1 };
        }
        if (sql.includes("from monthly_campaign_items item")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("insert into publication_outbox")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("insert into short_link_placements")) {
          return { rows: [{ id: "501" }], rowCount: 1 };
        }
        if (sql.includes("insert into publication_tracking_snapshots")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("insert into audit_events")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected transaction query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(tx),
      query: vi.fn().mockResolvedValue({
        rows: [{
          post_id: "81",
          channel_id: "12",
          network: "vk",
          title: "Практика",
          post_status: "scheduled",
          queue_status: "enqueued",
        }],
      }),
    };
    mocks.getPool.mockReturnValue(pool);

    const response = await POST(request());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      operationId: 91,
      operationStatus: "queued",
      destinations: [{ postId: 81, channelId: 12 }],
    });
    const operationInsert = tx.query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into publication_operations"));
    const placementInsert = tx.query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into short_link_placements"));
    const placementSlug = String(placementInsert?.[1]?.[4]);
    expect(placementSlug).toMatch(/^[A-Za-z0-9_-]{20,64}$/u);
    const placementPath = `/r/${placementSlug}`;
    const placementUrl = `http://localhost${placementPath}`;
    expect(String(operationInsert?.[0])).toContain("(project_id, user_id");
    expect(operationInsert?.[1]?.[0]).toBe(23);
    expect(JSON.parse(String(operationInsert?.[1]?.[13]))).toMatchObject({
      fingerprintVersion: 2,
      editorialApproval: {
        revisionId: 91,
        draftVersion: 3,
        contentHash: "a".repeat(64),
      },
      typography: {
        rulesVersion: "aurora-ru-typographer-v2",
        dictionaryVersion: 4,
        status: "clean",
      },
      tracking: {
        shortLinkId: 17,
        shortUrlPath: placementPath,
        destination: "https://example.test/consultation?utm_source=vk&utm_campaign=bankruptcy_august",
        utmValues: { utm_source: "vk", utm_campaign: "bankruptcy_august" },
        placement: "cta",
        snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        publicUrl: placementUrl,
        firstCommentText: null,
      },
    });
    expect(operationInsert?.[1]?.[6]).toBe(
      `Проверенный материал\n\nПодробнее: ${placementUrl}`,
    );
    expect(operationInsert?.[1]?.slice(14, 17)).toEqual([91, 3, "a".repeat(64)]);
    const postInsert = tx.query.mock.calls.find(([sql]) => String(sql).includes("insert into posts"));
    expect(String(postInsert?.[0])).toContain("(project_id, user_id");
    expect(postInsert?.[1]?.[0]).toBe(23);
    expect(postInsert?.[1]?.[3]).toBe(
      `Проверенный материал\n\nПодробнее: ${placementUrl}`,
    );
    expect(String(operationInsert?.[1]?.[6])).not.toContain("НЕОДОБРЕННАЯ");
    expect(String(postInsert?.[1]?.[3])).not.toContain("НЕОДОБРЕННАЯ");
    const lineageUpdate = tx.query.mock.calls.find(([sql]) =>
      String(sql).startsWith("update monthly_campaign_items item"));
    expect(String(lineageUpdate?.[0])).toContain("item.project_id = $1 and item.draft_id = $2");
    expect(String(lineageUpdate?.[0])).toContain("item.post_id is null or item.post_id = $3");
    expect(lineageUpdate?.[1]).toEqual([23, 41, "81"]);
    const trackingInsert = tx.query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into publication_tracking_snapshots"));
    expect(trackingInsert?.[1]).toEqual([
      23,
      "91",
      "81",
      17,
      501,
      "cta",
      "https://example.test/consultation?utm_source=vk&utm_campaign=bankruptcy_august",
      placementPath,
      JSON.stringify({ utm_source: "vk", utm_campaign: "bankruptcy_august" }),
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    ]);
    const auditInsert = tx.query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into audit_events"));
    expect(String(auditInsert?.[0])).toContain("'publication.scheduled'");
    expect(JSON.parse(String(auditInsert?.[1]?.[3]))).toMatchObject({
      draftId: 41,
      draftVersion: 3,
      scheduledAt: "2099-08-20T08:00:00.000Z",
      timezone: "Europe/Amsterdam",
      offset: "+02:00",
      disambiguation: "reject",
      scheduleOverride: false,
    });
    expect(mocks.reconcilePublicationOutbox).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 91,
    }));
    expect(mocks.recheckTypographyForPublication).toHaveBeenCalledWith({
      db: tx,
      projectId: 23,
      text: "Проверенный материал",
      allowPublishAsIs: true,
    });
  });

  it("treats exact editorial approval as AI review after a no-op draft version", async () => {
    mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
    const schedule = {
      scheduledAt: "2099-08-21T08:15:00.000Z",
      localDate: "2099-08-21",
      localTime: "10:15",
      timezone: "Europe/Amsterdam",
      disambiguation: "reject",
      offset: "+02:00",
    };
    const tx = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === "begin" || sql === "commit") return { rows: [], rowCount: null };
        if (sql.includes("from publication_operations") && sql.includes("idempotency_key")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("from drafts d")) {
          return {
            rows: [mutableDraftSnapshot({
              version: "4",
              origin: "ai",
              generation_result_id: "77",
            })],
            rowCount: 1,
          };
        }
        if (sql.includes("from draft_revisions revision")) {
          return {
            rows: [approvedRevisionRow({
              snapshot: approvedRevisionSnapshot({
                origin: "ai",
                schedule: {
                  scheduledAt: null,
                  timezone: null,
                  localDate: null,
                  localTime: null,
                  offset: null,
                  disambiguation: null,
                },
              }),
            })],
            rowCount: 1,
          };
        }
        if (sql.includes("approved_revision_id = $3")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("from channels channel")) {
          return { rows: [{ channel_id: "12", network: "vk" }], rowCount: 1 };
        }
        if (sql.includes("insert into publication_operations")) {
          return {
            rows: [{
              id: "91",
              project_id: "23",
              draft_id: "41",
              draft_version: "3",
              fingerprint: params?.[5],
              status: "pending",
              scheduled_at: schedule.scheduledAt,
              timezone: schedule.timezone,
              schedule_offset: schedule.offset,
              schedule_disambiguation: schedule.disambiguation,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("insert into posts")) {
          return { rows: [{ id: "81", schedule_revision: "1" }], rowCount: 1 };
        }
        if (sql.startsWith("update monthly_campaign_items item")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("from monthly_campaign_items item")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("insert into publication_outbox")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("insert into audit_events")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected schedule transaction query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(tx),
      query: vi.fn().mockResolvedValue({
        rows: [{
          post_id: "81",
          channel_id: "12",
          network: "vk",
          title: "Практика",
          post_status: "scheduled",
          queue_status: "enqueued",
        }],
      }),
    };
    mocks.getPool.mockReturnValue(pool);

    const response = await POST(request(undefined, { draftVersion: 4, schedule }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      draftVersion: 3,
      scheduledAt: schedule.scheduledAt,
      destinations: [{ postId: 81, channelId: 12 }],
    });
    expect(mocks.requireCurrentDraftApproval).toHaveBeenCalledWith(tx, 5, 23, 41);
    const operationInsert = tx.query.mock.calls.find(([sql]) =>
      String(sql).includes("insert into publication_operations"));
    expect(operationInsert?.[1]?.slice(8, 12)).toEqual([
      schedule.scheduledAt,
      schedule.timezone,
      schedule.offset,
      schedule.disambiguation,
    ]);
    expect(operationInsert?.[1]?.[3]).toBe(3);
    expect(operationInsert?.[1]?.slice(14, 17)).toEqual([91, 3, "a".repeat(64)]);
    const postInsert = tx.query.mock.calls.find(([sql]) => String(sql).includes("insert into posts"));
    expect(postInsert?.[1]?.[3]).toBe("Проверенный материал");
    expect(postInsert?.[1]?.slice(5, 6)).toEqual([schedule.scheduledAt]);
    expect(postInsert?.[1]?.slice(11, 14)).toEqual([
      schedule.timezone,
      schedule.offset,
      schedule.disambiguation,
    ]);
    expect(postInsert?.[1]?.[10]).toBe(3);
    expect(tx.query.mock.calls.some(([sql]) => /^update\s+drafts\b/iu.test(String(sql).trim()))).toBe(false);
    const auditInsert = tx.query.mock.calls.find(([sql]) =>
      String(sql).includes("'publication.scheduled'"));
    expect(JSON.parse(String(auditInsert?.[1]?.[3]))).toMatchObject({
      draftVersion: 3,
      requestedDraftVersion: 4,
      approvedRevisionId: 91,
      approvedContentHash: "a".repeat(64),
      scheduledAt: schedule.scheduledAt,
      timezone: schedule.timezone,
      offset: schedule.offset,
      disambiguation: schedule.disambiguation,
      scheduleOverride: true,
    });
  });

  it("never lets exact editorial approval override a blocked AI result", async () => {
    mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
    const tx = {
      query: vi.fn(async (sql: string) => {
        if (sql === "begin" || sql === "rollback") return { rows: [], rowCount: null };
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
        if (sql.includes("from drafts d")) {
          return {
            rows: [mutableDraftSnapshot({
              origin: "ai",
              generation_result_id: "77",
              ai_validation: blockedAiValidation(),
            })],
            rowCount: 1,
          };
        }
        if (sql.includes("from draft_revisions revision")) {
          return {
            rows: [approvedRevisionRow({
              snapshot: approvedRevisionSnapshot({ origin: "ai" }),
            })],
            rowCount: 1,
          };
        }
        if (sql.includes("operation.approved_revision_id = $3")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("from channels channel")) {
          return { rows: [{ channel_id: "12", network: "vk" }], rowCount: 1 };
        }
        throw new Error(`unexpected blocked-AI query: ${sql}`);
      }),
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(tx) });

    const response = await POST(request());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "ai_draft_blocked" });
    expect(mocks.requireCurrentDraftApproval).toHaveBeenCalledWith(tx, 5, 23, 41);
    expect(mocks.recheckTypographyForPublication).not.toHaveBeenCalled();
    expect(tx.query.mock.calls.some(([sql]) =>
      String(sql).includes("insert into publication_operations"))).toBe(false);
    expect(tx.query).toHaveBeenCalledWith("rollback");
  });

  it("converges concurrent publication attempts by two publishers on one approved revision", async () => {
    mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
    mocks.getSessionUser
      .mockResolvedValueOnce({ id: 5 })
      .mockResolvedValueOnce({ id: 6 });
    let resolveWinnerInserted!: () => void;
    const winnerInserted = new Promise<void>((resolve) => {
      resolveWinnerInserted = resolve;
    });
    let persistedFingerprint = "";
    const attemptedFingerprints: string[] = [];

    function publicationTransaction(winner: boolean) {
      let lineageLookups = 0;
      return {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          if (sql === "begin" || sql === "commit") return { rows: [], rowCount: null };
          if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
          if (sql.includes("from drafts d")) {
            return { rows: [mutableDraftSnapshot()], rowCount: 1 };
          }
          if (sql.includes("from draft_revisions revision")) {
            return { rows: [approvedRevisionRow()], rowCount: 1 };
          }
          if (sql.includes("approved_revision_id = $3")) {
            lineageLookups += 1;
            if (lineageLookups === 1) return { rows: [], rowCount: 0 };
            await winnerInserted;
            return {
              rows: [{
                id: "91",
                project_id: "23",
                draft_id: "41",
                draft_version: "3",
                approved_revision_id: "91",
                approved_draft_version: "3",
                approved_content_hash: "a".repeat(64),
                fingerprint: persistedFingerprint,
                status: "pending",
                scheduled_at: "2099-08-20T08:00:00.000Z",
                timezone: "Europe/Amsterdam",
                schedule_offset: "+02:00",
                schedule_disambiguation: "reject",
              }],
              rowCount: 1,
            };
          }
          if (sql.includes("from channels channel")) {
            return { rows: [{ channel_id: "12", network: "vk" }], rowCount: 1 };
          }
          if (sql.includes("insert into publication_operations")) {
            const fingerprint = String(params?.[5]);
            attemptedFingerprints.push(fingerprint);
            if (!winner) {
              await winnerInserted;
              return { rows: [], rowCount: 0 };
            }
            persistedFingerprint = fingerprint;
            resolveWinnerInserted();
            return {
              rows: [{
                id: "91",
                project_id: "23",
                draft_id: "41",
                draft_version: "3",
                approved_revision_id: "91",
                approved_draft_version: "3",
                approved_content_hash: "a".repeat(64),
                fingerprint,
                status: "pending",
                scheduled_at: "2099-08-20T08:00:00.000Z",
                timezone: "Europe/Amsterdam",
                schedule_offset: "+02:00",
                schedule_disambiguation: "reject",
              }],
              rowCount: 1,
            };
          }
          if (sql.includes("insert into posts")) {
            if (!winner) throw new Error("losing publisher created a duplicate post");
            return { rows: [{ id: "81", schedule_revision: "1" }], rowCount: 1 };
          }
          if (sql.includes("from posts post") && sql.includes("publication_operation_id")) {
            return { rows: [{ id: "81" }], rowCount: 1 };
          }
          if (sql.startsWith("update monthly_campaign_items item")) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("from monthly_campaign_items item")) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes("insert into publication_outbox")) {
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes("insert into audit_events")) {
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`unexpected concurrent publication query: ${sql}`);
        }),
        release: vi.fn(),
      };
    }

    const winner = publicationTransaction(true);
    const loser = publicationTransaction(false);
    const pool = {
      connect: vi.fn()
        .mockResolvedValueOnce(winner)
        .mockResolvedValueOnce(loser),
      query: vi.fn().mockResolvedValue({
        rows: [{
          post_id: "81",
          channel_id: "12",
          network: "vk",
          title: "Практика",
          post_status: "scheduled",
          queue_status: "enqueued",
        }],
      }),
    };
    mocks.getPool.mockReturnValue(pool);

    const [firstResponse, secondResponse] = await Promise.all([
      POST(request()),
      POST(request()),
    ]);

    expect([firstResponse.status, secondResponse.status].sort()).toEqual([200, 201]);
    const [firstBody, secondBody] = await Promise.all([
      firstResponse.json(),
      secondResponse.json(),
    ]);
    expect(firstBody.operationId).toBe(91);
    expect(secondBody.operationId).toBe(91);
    expect([firstBody.replayed, secondBody.replayed].sort()).toEqual([false, true]);
    expect(attemptedFingerprints).toHaveLength(2);
    expect(new Set(attemptedFingerprints)).toEqual(new Set([persistedFingerprint]));
    const actorIds = [winner, loser].flatMap((transaction) =>
      transaction.query.mock.calls
        .filter(([sql]) => String(sql).includes("insert into publication_operations"))
        .map(([, params]) => Number(params?.[1])));
    expect(actorIds.sort()).toEqual([5, 6]);
    expect([winner, loser].reduce((count, transaction) => count
      + transaction.query.mock.calls.filter(([sql]) => String(sql).includes("insert into posts")).length, 0))
      .toBe(1);
    const fallbackLookup = loser.query.mock.calls.find(([sql]) =>
      String(sql).includes("approved_revision_id = $3")
      && !String(sql).includes("operation.approved_revision_id"));
    expect(fallbackLookup?.[1]).toEqual([23, 41, 91]);
    expect(String(fallbackLookup?.[0])).not.toContain("user_id");
  });

  it("replays approved lineage independently of publisher and current draft version", async () => {
    mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
    const tx = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === "begin" || sql === "commit") return { rows: [], rowCount: null };
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
        if (sql.includes("from drafts d")) {
          return { rows: [mutableDraftSnapshot({ version: "4" })], rowCount: 1 };
        }
        if (sql.includes("from draft_revisions revision")) {
          return { rows: [approvedRevisionRow()], rowCount: 1 };
        }
        if (sql.includes("operation.approved_revision_id = $3")) {
          expect(params).toEqual([23, 41, 91]);
          expect(sql).not.toContain("user_id");
          expect(sql).not.toContain("draft_version =");
          return {
            rows: [{
              id: "91",
              project_id: "23",
              draft_id: "41",
              draft_version: "3",
              approved_revision_id: "91",
              approved_draft_version: "3",
              approved_content_hash: "a".repeat(64),
              fingerprint: "f".repeat(64),
              status: "queued",
              scheduled_at: "2099-08-20T08:00:00.000Z",
              timezone: "Europe/Amsterdam",
              schedule_offset: "+02:00",
              schedule_disambiguation: "reject",
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("from posts post") && sql.includes("publication_operation_id")) {
          expect(params).toEqual(["91", 23]);
          return { rows: [{ id: "81" }], rowCount: 1 };
        }
        if (sql.startsWith("update monthly_campaign_items item")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("from monthly_campaign_items item")) {
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected approved-lineage replay query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(tx),
      query: vi.fn().mockResolvedValue({
        rows: [{
          post_id: "81",
          channel_id: "12",
          network: "vk",
          title: "Практика",
          post_status: "scheduled",
          queue_status: "enqueued",
        }],
      }),
    };
    mocks.getPool.mockReturnValue(pool);

    const response = await POST(request(undefined, { draftVersion: 99 }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      operationId: 91,
      draftVersion: 3,
      replayed: true,
    });
    expect(tx.query.mock.calls.some(([sql]) =>
      String(sql).includes("insert into publication_operations"))).toBe(false);
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("insert into posts"))).toBe(false);
  });

  it.each([
    {
      name: "an unknown schedule field",
      schedule: {
        scheduledAt: "2099-08-21T08:15:00.000Z",
        localDate: "2099-08-21",
        localTime: "10:15",
        timezone: "Europe/Amsterdam",
        disambiguation: "reject",
        offset: "+02:00",
        unexpected: true,
      },
      error: "schedule_contract_required",
    },
    {
      name: "a nonexistent DST local time",
      schedule: {
        scheduledAt: "2026-03-29T01:30:00.000Z",
        localDate: "2026-03-29",
        localTime: "02:30",
        timezone: "Europe/Amsterdam",
        disambiguation: "reject",
        offset: "+01:00",
      },
      error: "nonexistent_local_time",
    },
    {
      name: "a stale instant",
      schedule: {
        scheduledAt: "2020-08-01T08:00:00.000Z",
        localDate: "2020-08-01",
        localTime: "10:00",
        timezone: "Europe/Amsterdam",
        disambiguation: "reject",
        offset: "+02:00",
      },
      error: "past",
    },
  ])("rejects $name only after checking the exact approval", async ({ schedule, error }) => {
    mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
    const tx = {
      query: vi.fn(async (sql: string) => {
        if (sql === "begin" || sql === "rollback") return { rows: [], rowCount: null };
        if (sql.includes("from publication_operations") && sql.includes("idempotency_key")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("from drafts d")) {
          return { rows: [mutableDraftSnapshot()], rowCount: 1 };
        }
        if (sql.includes("from draft_revisions revision")) {
          return {
            rows: [approvedRevisionRow()],
            rowCount: 1,
          };
        }
        if (sql.includes("approved_revision_id = $3")) {
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected invalid-schedule query: ${sql}`);
      }),
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(tx) });

    const response = await POST(request(undefined, { schedule }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error });
    expect(mocks.requireCurrentDraftApproval).toHaveBeenCalledWith(tx, 5, 23, 41);
    const approvalQueryIndex = tx.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("from draft_revisions revision"));
    expect(approvalQueryIndex).toBeGreaterThan(-1);
    expect(tx.query.mock.calls.some(([sql]) =>
      String(sql).includes("insert into publication_operations"))).toBe(false);
    expect(tx.query.mock.calls.some(([sql]) => /^update\s+drafts\b/iu.test(String(sql).trim()))).toBe(false);
    expect(tx.query).toHaveBeenCalledWith("rollback");
  });

  it("repairs monthly campaign lineage on replay without creating another post", async () => {
    mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
    const tx = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === "begin" || sql === "commit") return { rows: [], rowCount: null };
        if (sql.includes("from publication_operations") && sql.includes("idempotency_key")) {
          return { rows: [{
            id: "91",
            project_id: "23",
            draft_id: "41",
            draft_version: "3",
            fingerprint: "f".repeat(64),
            status: "queued",
            scheduled_at: "2099-08-20T08:00:00.000Z",
          }], rowCount: 1 };
        }
        if (sql.includes("from posts post") && sql.includes("publication_operation_id")) {
          expect(params).toEqual(["91", 23]);
          return { rows: [{ id: "81" }], rowCount: 1 };
        }
        if (sql.startsWith("update monthly_campaign_items item")) {
          expect(sql).toContain("item.project_id = $1 and item.draft_id = $2");
          expect(params).toEqual([23, 41, "81"]);
          return { rows: [{ id: "701" }], rowCount: 1 };
        }
        if (sql.includes("from monthly_campaign_items item")) {
          expect(sql).toContain("item.project_id = $1 and item.draft_id = $2");
          expect(params).toEqual([23, 41, "81"]);
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected replay query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(tx),
      query: vi.fn().mockResolvedValue({
        rows: [{
          post_id: "81",
          channel_id: "12",
          network: "vk",
          title: "Практика",
          post_status: "scheduled",
          queue_status: "enqueued",
        }],
      }),
    };
    mocks.getPool.mockReturnValue(pool);

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      operationId: 91,
      replayed: true,
      destinations: [{ postId: 81, channelId: 12 }],
    });
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("insert into posts"))).toBe(false);
    expect(tx.query.mock.calls.filter(([sql]) =>
      String(sql).startsWith("update monthly_campaign_items item"))).toHaveLength(1);
    expect(tx.query).toHaveBeenCalledWith("commit");
  });

  it("rolls back and reports operation_not_created when PostgreSQL fails before commit", async () => {
    mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
    const databaseError = Object.assign(new Error("snapshot unavailable"), { code: "XX000" });
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // begin
        .mockRejectedValueOnce(databaseError) // replay lookup
        .mockResolvedValueOnce({ rows: [] }), // rollback
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      result: "operation_not_created",
      error: "operation_not_created",
    });
    expect(client.query).toHaveBeenLastCalledWith("rollback");
    expect(client.release).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });
});
