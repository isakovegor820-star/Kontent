import { beforeEach, describe, expect, it, vi } from "vitest";

const security = vi.hoisted(() => ({ projectId: 7, denied: new Set<string>() }));
const mocks = vi.hoisted(() => ({
  selectedPermission: vi.fn(),
  projectPermission: vi.fn(),
  recordDraftRevision: vi.fn(),
  requireExactApproval: vi.fn(),
}));

vi.mock("./project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-permissions")>();
  return {
    ...actual,
    requireSelectedProjectPermission: mocks.selectedPermission,
    requireProjectPermission: mocks.projectPermission,
  };
});
vi.mock("./editorial-approval", () => ({
  recordDraftRevisionInTransaction: mocks.recordDraftRevision,
  requireExactDraftApproval: mocks.requireExactApproval,
  EditorialValidationError: class EditorialValidationError extends Error {
    constructor(public readonly code: string) { super(code); }
  },
}));

import { legalVideoDraftContentHash } from "./legal-video-script";
import {
  createLegalVideoScriptRecord,
  getLegalVideoScript,
  listLegalVideoScripts,
  updateLegalVideoScriptRecord,
} from "./legal-video-script-service";
import { ProjectAccessError } from "./project-permissions";

type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number };

function transactionHarness(handler: (sql: string, params: unknown[]) => QueryResult | Promise<QueryResult>) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
    return handler(sql, params);
  });
  const client = { query, release: vi.fn() };
  return { pool: { connect: vi.fn(async () => client), query }, query };
}

function scriptRow(snapshot: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: 201,
    project_id: 7,
    source_draft_revision_id: 91,
    source_draft_id: 51,
    source_draft_version: 4,
    source_content_hash: snapshot.sourceDraft && typeof snapshot.sourceDraft === "object"
      ? (snapshot.sourceDraft as Record<string, unknown>).contentHash
      : "a".repeat(64),
    title: snapshot.title,
    duration_seconds: snapshot.durationSeconds,
    revision: snapshot.revision,
    revision_hash: snapshot.revisionHash,
    snapshot,
    request_hash: "c".repeat(64),
    created_at: "2026-08-22T10:00:00.000Z",
    updated_at: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

const draftText = "Срок ответа составляет десять дней. Проверьте условия договора и сохраните памятку.";
const exactDraftRevisionHash = "e".repeat(64);

describe("legal video script project service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    security.projectId = 7;
    security.denied.clear();
    mocks.selectedPermission.mockImplementation(async (_db, userId: number, permission: string) => {
      if (security.denied.has(permission)) throw new ProjectAccessError("permission_denied");
      return { projectId: security.projectId, userId, role: "owner", version: 1 };
    });
    mocks.projectPermission.mockImplementation(async (_db, userId: number, projectId: number, permission: string) => {
      if (projectId !== security.projectId || security.denied.has(permission)) {
        throw new ProjectAccessError("permission_denied");
      }
      return { projectId, userId, role: "owner", version: 1 };
    });
    mocks.recordDraftRevision.mockResolvedValue({
      id: 91,
      draftId: 51,
      draftVersion: 4,
      contentHash: exactDraftRevisionHash,
      snapshot: { text: draftText },
      createdAt: "2026-08-22T09:00:00.000Z",
    });
    mocks.requireExactApproval.mockResolvedValue({
      revisionId: 91,
      contentHash: exactDraftRevisionHash,
    });
  });

  it("scopes list/get reads to project A and never returns a script from project B", async () => {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      expect(sql).toMatch(/project_id = \$[12]/u);
      expect(params).toContain(7);
      return { rows: [] };
    });

    await expect(listLegalVideoScripts({ pool: { query } as never, actorUserId: 12 }))
      .resolves.toEqual([]);
    await expect(getLegalVideoScript({ pool: { query } as never, actorUserId: 12, scriptId: 999 }))
      .rejects.toMatchObject({ code: "not_found" });
    expect(mocks.selectedPermission).toHaveBeenCalledWith(expect.anything(), 12, "project.read");
  });

  it("requires create and edit RBAC before any script domain write", async () => {
    security.denied.add("content.create");
    const denied = transactionHarness(() => ({ rows: [] }));
    await expect(createLegalVideoScriptRecord({
      pool: denied.pool as never,
      actorUserId: 12,
      draftId: 51,
      requestKey: "video-create-001",
    })).rejects.toBeInstanceOf(ProjectAccessError);
    expect(denied.query.mock.calls.some(([sql]) => String(sql).includes("insert into legal_video_scripts"))).toBe(false);

    security.denied.clear();
    security.denied.add("content.edit");
    const deniedEdit = transactionHarness(() => ({ rows: [] }));
    await expect(updateLegalVideoScriptRecord({
      pool: deniedEdit.pool as never,
      actorUserId: 12,
      scriptId: 201,
      expectedRevision: 1,
      title: "Новый заголовок",
    })).rejects.toBeInstanceOf(ProjectAccessError);
    expect(deniedEdit.query.mock.calls.some(([sql]) => String(sql).includes("update legal_video_scripts"))).toBe(false);
  });

  it("cannot update a script id from project B through project A", async () => {
    const h = transactionHarness((sql, params) => {
      if (sql.includes("for update")) {
        expect(params).toEqual([909, 7]);
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(updateLegalVideoScriptRecord({
      pool: h.pool as never,
      actorUserId: 12,
      scriptId: 909,
      expectedRevision: 1,
      title: "Чужой сценарий",
    })).rejects.toMatchObject({ code: "not_found" });
    expect(h.query.mock.calls.some(([sql]) => String(sql).startsWith("update legal_video_scripts"))).toBe(false);
  });

  it("binds the exact draft revision/hash and replays only an equal normalized create intent", async () => {
    let stored: Record<string, unknown> | undefined;
    const h = transactionHarness((sql, params) => {
      if (sql.includes("from legal_video_scripts") && sql.includes("request_key = $2")) {
        return { rows: stored ? [stored] : [] };
      }
      if (sql.includes("insert into legal_video_scripts")) {
        const snapshot = JSON.parse(String(params[10])) as Record<string, unknown>;
        expect(String(params[12])).toMatch(/^[0-9a-f]{64}$/u);
        stored = scriptRow(snapshot, {
          source_content_hash: params[4],
          title: params[6],
          duration_seconds: params[7],
          revision: params[8],
          revision_hash: params[9],
          request_hash: params[12],
        });
        return { rows: [stored] };
      }
      if (sql.includes("insert into legal_video_script_revisions")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const input = {
      pool: h.pool as never,
      actorUserId: 12,
      draftId: 51,
      requestKey: "video-create-001",
      durationSeconds: 45,
      title: " Срок   ответа ",
    };

    const created = await createLegalVideoScriptRecord(input);
    const replayed = await createLegalVideoScriptRecord({ ...input, title: "Срок ответа" });

    expect(created).toMatchObject({
      duplicate: false,
      script: {
        projectId: 7,
        sourceDraftId: 51,
        sourceDraftRevisionId: 91,
        sourceDraftVersion: 4,
        sourceContentHash: exactDraftRevisionHash,
      },
    });
    expect(created.script.script.sourceDraft).toMatchObject({
      id: 51,
      revision: 4,
      contentHash: legalVideoDraftContentHash(draftText),
      body: draftText,
    });
    expect(created.script.script.scenes.at(-1)).toMatchObject({
      role: "cta",
      voiceOver: "Сохраните разбор.",
      onScreenText: "Сохраните разбор",
      sourceClaimIds: [],
    });
    expect(replayed).toMatchObject({ duplicate: true, script: { id: 201 } });
    expect(mocks.recordDraftRevision).toHaveBeenCalledTimes(1);
    expect(mocks.projectPermission).toHaveBeenCalledWith(expect.anything(), 12, 7, "content.edit");
    expect(mocks.requireExactApproval).toHaveBeenCalledWith(expect.anything(), 12, 7, 51, "content.create");

    stored!.request_hash = null;
    await expect(createLegalVideoScriptRecord({ ...input, title: "Срок ответа" }))
      .resolves.toMatchObject({ duplicate: true });
    await expect(createLegalVideoScriptRecord({ ...input, durationSeconds: 60 }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(createLegalVideoScriptRecord({ ...input, draftId: 52 }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(mocks.recordDraftRevision).toHaveBeenCalledTimes(1);
  });

  it("inherits an exact project-owned verified radar source and binds factual scenes to it", async () => {
    const sourceText = "Срок ответа составляет десять дней. Источник описывает порядок ответа.";
    const verifiedAt = "2026-08-22T08:30:00.000Z";
    mocks.recordDraftRevision.mockResolvedValueOnce({
      id: 91,
      draftId: 51,
      draftVersion: 4,
      contentHash: exactDraftRevisionHash,
      snapshot: {
        text: draftText,
        channelIds: [41],
        sourceRef: {
          kind: "trend",
          id: "301",
          label: "Право сегодня",
          provenance: {
            kind: "radar_result",
            id: "301",
            label: "Право сегодня",
            url: "https://t.me/pravo_today/77",
          },
        },
      },
      createdAt: "2026-08-22T09:00:00.000Z",
    });
    let savedSnapshot: Record<string, unknown> | undefined;
    const h = transactionHarness((sql, params) => {
      if (sql.includes("request_key = $2")) return { rows: [] };
      if (sql.includes("from radar_search_results")) {
        expect(params).toEqual(["301", "https://t.me/pravo_today/77", 7, [41]]);
        expect(sql).toContain("result.verification_status = 'verified'");
        expect(sql).toContain("channel.project_id = $3");
        return {
          rows: [{
            id: "301",
            url: "https://t.me/pravo_today/77",
            title: "Право сегодня",
            handle: "pravo_today",
            description: null,
            text: sourceText,
            verified_at: verifiedAt,
          }],
        };
      }
      if (sql.includes("insert into legal_video_scripts")) {
        savedSnapshot = JSON.parse(String(params[10])) as Record<string, unknown>;
        return { rows: [scriptRow(savedSnapshot)] };
      }
      if (sql.includes("insert into legal_video_script_revisions")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const result = await createLegalVideoScriptRecord({
      pool: h.pool as never,
      actorUserId: 12,
      draftId: 51,
      requestKey: "video-verified-source-001",
      durationSeconds: 60,
    });

    expect(result.script.script.sourceEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "verified-source-radar-301",
        claim: "Срок ответа составляет десять дней.",
        excerpt: sourceText,
        source: {
          kind: "verified_source",
          sourceId: "radar_result:301",
          title: "Право сегодня",
          url: "https://t.me/pravo_today/77",
          checkedAt: verifiedAt,
          sourceContentHash: legalVideoDraftContentHash(sourceText),
        },
      }),
    ]));
    expect(result.script.script.scenes.filter((scene) => scene.role !== "cta"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceClaimIds: ["draft-claim", "verified-source-radar-301"] }),
      ]));
  });

  it("keeps only draft evidence when provenance has no server-owned verification record", async () => {
    mocks.recordDraftRevision.mockResolvedValueOnce({
      id: 91,
      draftId: 51,
      draftVersion: 4,
      contentHash: exactDraftRevisionHash,
      snapshot: {
        text: draftText,
        channelIds: [41],
        sourceRef: {
          kind: "trend",
          id: "88",
          label: "Новости права",
          provenance: {
            kind: "radar_result",
            id: "88",
            label: "Новости права",
            url: "https://t.me/legal_news/88",
          },
        },
      },
      createdAt: "2026-08-22T09:00:00.000Z",
    });
    const h = transactionHarness((sql, params) => {
      if (sql.includes("request_key = $2")) return { rows: [] };
      if (sql.includes("from radar_search_results")) return { rows: [] };
      if (sql.includes("insert into legal_video_scripts")) {
        const snapshot = JSON.parse(String(params[10])) as Record<string, unknown>;
        return { rows: [scriptRow(snapshot)] };
      }
      if (sql.includes("insert into legal_video_script_revisions")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    const result = await createLegalVideoScriptRecord({
      pool: h.pool as never,
      actorUserId: 12,
      draftId: 51,
      requestKey: "video-unverified-source-001",
    });

    expect(result.script.script.sourceEvidence).toHaveLength(1);
    expect(result.script.script.sourceEvidence[0]?.source).toMatchObject({ kind: "draft" });
    expect(JSON.stringify(result.script.script)).not.toContain("https://t.me/legal_news/88");
    expect(result.script.script.scenes.filter((scene) => scene.role !== "cta"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceClaimIds: ["draft-claim"] }),
      ]));
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes("radar_search_results"))).toBe(true);
  });

  it("refuses to derive a video script from a draft revision that is not exactly approved", async () => {
    mocks.requireExactApproval.mockResolvedValueOnce({ revisionId: 90, contentHash: "b".repeat(64) });
    const h = transactionHarness((sql) => {
      if (sql.includes("request_key = $2")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(createLegalVideoScriptRecord({
      pool: h.pool as never,
      actorUserId: 12,
      draftId: 51,
      requestKey: "video-unapproved-001",
    })).rejects.toMatchObject({ code: "approval_required" });
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes("insert into legal_video_scripts"))).toBe(false);
  });

  it("rejects a stale script revision before update", async () => {
    let stored: Record<string, unknown> | undefined;
    const seed = transactionHarness((sql, params) => {
      if (sql.includes("request_key = $2")) return { rows: [] };
      if (sql.includes("insert into legal_video_scripts")) {
        stored = scriptRow(JSON.parse(String(params[10])) as Record<string, unknown>, {
          source_content_hash: params[4],
          request_hash: params[12],
        });
        return { rows: [stored] };
      }
      if (sql.includes("insert into legal_video_script_revisions")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await createLegalVideoScriptRecord({
      pool: seed.pool as never,
      actorUserId: 12,
      draftId: 51,
      requestKey: "video-create-002",
    });
    const h = transactionHarness((sql) => {
      if (sql.includes("for update")) return { rows: [stored!] };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(updateLegalVideoScriptRecord({
      pool: h.pool as never,
      actorUserId: 12,
      scriptId: 201,
      expectedRevision: 99,
      title: "Новый заголовок",
    })).rejects.toMatchObject({ code: "version_conflict" });
    expect(h.query.mock.calls.some(([sql]) => String(sql).startsWith("update legal_video_scripts"))).toBe(false);
  });
});
