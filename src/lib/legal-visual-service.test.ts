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
  mocks.selectedPermission.mockImplementation(async (_db, userId: number, permission: string) => {
    if (security.denied.has(permission)) throw new actual.ProjectAccessError("permission_denied");
    return { projectId: security.projectId, userId, role: "owner", version: 1 };
  });
  mocks.projectPermission.mockImplementation(async (_db, userId: number, projectId: number, permission: string) => {
    if (projectId !== security.projectId || security.denied.has(permission)) {
      throw new actual.ProjectAccessError("permission_denied");
    }
    return { projectId, userId, role: "owner", version: 1 };
  });
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

import { ProjectAccessError } from "./project-permissions";
import {
  createLegalVisualDesign,
  getLegalVisualDesign,
  listLegalVisualDesigns,
  updateLegalVisualDesign,
} from "./legal-visual-service";

type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number };

function transactionHarness(handler: (sql: string, params: unknown[]) => QueryResult | Promise<QueryResult>) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
    return handler(sql, params);
  });
  const client = { query, release: vi.fn() };
  return { pool: { connect: vi.fn(async () => client), query }, query, client };
}

function designRow(config: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    project_id: 7,
    name: config.name,
    format: config.format,
    status: "draft",
    revision: config.revision,
    rendered_revision: null,
    source_draft_id: 51,
    source_draft_revision_id: 91,
    source_draft_version: 4,
    source_content_hash: "a".repeat(64),
    config_hash: "b".repeat(64),
    config,
    request_hash: "c".repeat(64),
    error_code: null,
    error_message: null,
    created_at: "2026-08-22T10:00:00.000Z",
    updated_at: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

describe("legal visual project service", () => {
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
      contentHash: "a".repeat(64),
      snapshot: { text: "Срок ответа составляет десять дней. Проверьте договор. Сохраните памятку." },
      createdAt: "2026-08-22T09:00:00.000Z",
    });
    mocks.requireExactApproval.mockResolvedValue({
      revisionId: 91,
      contentHash: "a".repeat(64),
    });
  });

  it("scopes list/get reads to the server-selected project and cannot read project B", async () => {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      expect(sql).toMatch(/project_id = \$[12]/u);
      expect(params).toContain(7);
      return { rows: [] };
    });

    await expect(listLegalVisualDesigns({ pool: { query } as never, actorUserId: 12 }))
      .resolves.toEqual([]);
    await expect(getLegalVisualDesign({ pool: { query } as never, actorUserId: 12, designId: 999 }))
      .rejects.toMatchObject({ code: "not_found" });
    expect(mocks.selectedPermission).toHaveBeenCalledWith(expect.anything(), 12, "project.read");
    expect(query.mock.calls.every(([, params]) => !JSON.stringify(params).includes("project B"))).toBe(true);
  });

  it("requires create/edit permissions and performs no domain write when RBAC denies", async () => {
    security.denied.add("content.create");
    const denied = transactionHarness(() => ({ rows: [] }));
    await expect(createLegalVisualDesign({
      pool: denied.pool as never,
      actorUserId: 12,
      requestKey: "visual-create-001",
      name: "Памятка",
    })).rejects.toBeInstanceOf(ProjectAccessError);
    expect(denied.query.mock.calls.some(([sql]) => String(sql).includes("insert into legal_visual_designs"))).toBe(false);

    security.denied.clear();
    security.denied.add("content.edit");
    const deniedEdit = transactionHarness(() => ({ rows: [] }));
    await expect(updateLegalVisualDesign({
      pool: deniedEdit.pool as never,
      actorUserId: 12,
      designId: 101,
      expectedRevision: 1,
      config: {},
    })).rejects.toBeInstanceOf(ProjectAccessError);
    expect(deniedEdit.query.mock.calls.some(([sql]) => String(sql).includes("update legal_visual_designs"))).toBe(false);
  });

  it("cannot update a design id that belongs outside the selected project", async () => {
    const h = transactionHarness((sql, params) => {
      if (sql.includes("for update")) {
        expect(params).toEqual([808, 7]);
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(updateLegalVisualDesign({
      pool: h.pool as never,
      actorUserId: 12,
      designId: 808,
      expectedRevision: 1,
      config: {},
    })).rejects.toMatchObject({ code: "not_found" });
    expect(h.query.mock.calls.some(([sql]) => String(sql).startsWith("update legal_visual_designs"))).toBe(false);
  });

  it("persists exact draft revision/hash lineage and replays only an equal create intent", async () => {
    let stored: Record<string, unknown> | undefined;
    const h = transactionHarness((sql, params) => {
      if (sql.includes("from legal_visual_designs") && sql.includes("request_key = $2")) {
        return { rows: stored ? [stored] : [] };
      }
      if (sql.includes("from draft_revisions")) {
        expect(params).toEqual([91, 7, 51]);
        return { rows: [{
          id: 91,
          draft_version: 4,
          content_hash: "a".repeat(64),
          snapshot: { text: "Срок ответа составляет десять дней. Проверьте договор. Сохраните памятку." },
        }] };
      }
      if (sql.includes("from projects project")) return { rows: [{ name: "Аврора", colors: null }] };
      if (sql.includes("insert into legal_visual_designs")) {
        const config = JSON.parse(String(params[8])) as Record<string, unknown>;
        expect(String(params[11])).toMatch(/^[0-9a-f]{64}$/u);
        stored = designRow(config, {
          config_hash: params[9],
          request_hash: params[11],
          name: params[6],
          format: params[7],
        });
        return { rows: [stored] };
      }
      if (sql.startsWith("delete from legal_visual_source_assets")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const input = {
      pool: h.pool as never,
      actorUserId: 12,
      requestKey: "visual-create-001",
      sourceDraftId: 51,
      name: "Срок ответа",
      format: "4:5",
      template: "deadlines",
    } as const;

    const created = await createLegalVisualDesign(input);
    const replayed = await createLegalVisualDesign(input);

    expect(created).toMatchObject({
      duplicate: false,
      design: {
        projectId: 7,
        sourceDraftId: 51,
        sourceDraftRevisionId: 91,
        sourceDraftVersion: 4,
        sourceContentHash: "a".repeat(64),
      },
    });
    expect(replayed).toMatchObject({ duplicate: true, design: { id: 101 } });
    expect(mocks.recordDraftRevision).toHaveBeenCalledTimes(1);
    expect(mocks.recordDraftRevision).toHaveBeenCalledWith(expect.anything(), {
      draftId: 51,
      actorUserId: 12,
      projectId: 7,
    });
    expect(mocks.requireExactApproval).toHaveBeenCalledWith(expect.anything(), 12, 7, 51, "content.create");
    await expect(createLegalVisualDesign({ ...input, name: "Другая карусель" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    stored!.request_hash = null;
    await expect(createLegalVisualDesign(input)).resolves.toMatchObject({ duplicate: true });
    await expect(createLegalVisualDesign({ ...input, format: "9:16" }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(mocks.recordDraftRevision).toHaveBeenCalledTimes(1);
  });

  it("refuses to derive a visual from a draft revision that is not exactly approved", async () => {
    mocks.requireExactApproval.mockResolvedValueOnce({ revisionId: 90, contentHash: "b".repeat(64) });
    const h = transactionHarness((sql) => {
      if (sql.includes("request_key = $2")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(createLegalVisualDesign({
      pool: h.pool as never,
      actorUserId: 12,
      requestKey: "visual-unapproved-001",
      sourceDraftId: 51,
      name: "Памятка",
    })).rejects.toMatchObject({ code: "approval_required" });
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes("insert into legal_visual_designs"))).toBe(false);
  });

  it("rejects a stale visual revision before mutation", async () => {
    const seeded = await (async () => {
      let row: Record<string, unknown> | undefined;
      const h = transactionHarness((sql, params) => {
        if (sql.includes("request_key = $2")) return { rows: [] };
        if (sql.includes("from projects project")) return { rows: [{ name: "Аврора", colors: null }] };
        if (sql.includes("insert into legal_visual_designs")) {
          row = designRow(JSON.parse(String(params[8])) as Record<string, unknown>, {
            source_draft_id: null,
            source_draft_revision_id: null,
            source_draft_version: null,
            source_content_hash: null,
            config_hash: params[9],
            request_hash: params[11],
          });
          return { rows: [row] };
        }
        if (sql.startsWith("delete from legal_visual_source_assets")) return { rows: [] };
        throw new Error(`unexpected SQL: ${sql}`);
      });
      await createLegalVisualDesign({
        pool: h.pool as never,
        actorUserId: 12,
        requestKey: "visual-create-002",
        name: "Памятка",
      });
      return row!;
    })();
    const h = transactionHarness((sql) => {
      if (sql.includes("for update")) return { rows: [seeded] };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(updateLegalVisualDesign({
      pool: h.pool as never,
      actorUserId: 12,
      designId: 101,
      expectedRevision: 99,
      config: seeded.config,
    })).rejects.toMatchObject({ code: "version_conflict" });
    expect(h.query.mock.calls.some(([sql]) => String(sql).startsWith("update legal_visual_designs"))).toBe(false);
  });
});
