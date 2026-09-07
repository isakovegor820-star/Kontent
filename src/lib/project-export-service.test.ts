import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/project-permissions", () => ({
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));

import {
  createProjectExportDownloadToken,
  createProjectExportOperation,
  getProjectExportOperation,
  previewProjectExport,
  ProjectExportServiceError,
  resolveProjectExportDownload,
  shouldQueueProjectExport,
} from "./project-export-service";
import { createProjectExportSnapshot, projectExportHash, renderProjectCsv, type ProjectExportSnapshot } from "./project-export.mjs";

type Result = { rows: Record<string, unknown>[]; rowCount?: number };

function operationRow(snapshot: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: "41",
    project_id: "7",
    export_kind: "content_plan",
    format: "csv",
    request_hash: "a".repeat(64),
    snapshot_hash: projectExportHash(snapshot),
    snapshot,
    status: "pending",
    filters: {},
    error_code: null,
    error_message: null,
    created_at: "2026-08-11T12:00:00.000Z",
    updated_at: "2026-08-11T12:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function sourceRow() {
  return {
    id: "51",
    project_id: "7",
    text: "Полезный пост\nПродолжение",
    status: "scheduled",
    occurred_at: "2026-08-11T10:00:00.000Z",
    external_message_id: null,
    tg_message_id: null,
    vk_post_id: null,
    network: "tg",
    channel_title: "ТехнологИИ Права",
    handle: "techlaw",
    vk_group_id: null,
    author_name: "Анна",
    campaign_title: "Тема кампании",
    rubric: "Практика",
    campaign_name: "Август",
    approver_name: "Ирина",
    destination_url: "https://example.test/page",
    short_url_path: "/r/abcdefghijklmnopqrst",
    utm_values: { utm_source: "telegram" },
  };
}

function transactionClient(handler: (sql: string, values: unknown[]) => Result | Promise<Result>) {
  return {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
      return handler(sql, values);
    }),
    release: vi.fn(),
  };
}

describe("project export service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 7,
      userId: 9,
      role: "owner",
      version: 1,
    });
  });


  it.each([
    ["published_unverified", "Доставка не подтверждена"],
    ["Доставка не подтверждена", "Доставка не подтверждена"],
    ["Опубликован, проверяется", "Доставка не подтверждена"],
    ["опубликован, проверяется", "Доставка не подтверждена"],
    ["published", "Опубликован"],
  ])("serializes truthful preview, snapshot and CSV for status filter %s", async (filter, expectedStatus) => {
    let insertedSnapshot: ProjectExportSnapshot | undefined;
    const sourceQueries: Array<{ sql: string; values: unknown[] }> = [];
    const client = transactionClient((sql, values) => {
      if (sql.includes("from project_export_operations")) return { rows: [] };
      if (sql.includes("insert into project_export_operations")) {
        insertedSnapshot = JSON.parse(String(values[7])) as ProjectExportSnapshot;
        return { rows: [operationRow(insertedSnapshot, { request_hash: values[5], snapshot_hash: values[8] })] };
      }
      return { rows: [], rowCount: 1 };
    });
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        if (sql.includes("from project_export_operations")) return { rows: [] };
        if (sql.includes("from projects")) return { rows: [{ id: 7, name: "Проект", timezone: "Europe/Amsterdam" }] };
        if (sql.includes("from posts post")) {
          sourceQueries.push({ sql, values });
          // This DB double returns the matching SQL-selected row. The real PG
          // integration proves exclusion before LIMIT and the snapshot boundary.
          return { rows: expectedStatus === "Опубликован"
            ? [{ ...sourceRow(), id: "52", status: "published" }]
            : [{ ...sourceRow(), status: "published_unverified" }] };
        }
        if (sql.includes("from monthly_campaign_items item")) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
      connect: vi.fn(async () => client),
    };
    const body = { kind: "content_plan" as const, format: "csv" as const,
      period: { from: "2026-08-01", to: "2026-08-31" }, filters: { status: filter } };
    const preview = await previewProjectExport({ db: pool as never, actorUserId: 9, body });
    expect(preview.rowCount).toBe(1);
    expect(preview.sample.map((row) => row.status)).toEqual([expectedStatus]);
    expect(preview.filters.status).toEqual([expectedStatus]);
    await createProjectExportOperation({ pool: pool as never, actorUserId: 9,
      requestKey: "export-unknown-001", body: { ...body, previewHash: preview.previewHash },
      now: () => new Date("2026-08-11T12:00:00.000Z") });
    expect(insertedSnapshot?.rows.map((row) => row.status)).toEqual([expectedStatus]);
    if (!insertedSnapshot) throw new Error("snapshot was not persisted");
    const csv = renderProjectCsv(insertedSnapshot).toString("utf8");
    expect(csv).toContain(expectedStatus);
    expect(csv).not.toContain("Опубликован, проверяется");
    expect(insertedSnapshot.rows[0].id).toBe(expectedStatus === "Опубликован" ? "52" : "51");
    for (const { sql, values } of sourceQueries) {
      expect(values[4]).toEqual([expectedStatus]);
      if (expectedStatus !== "Опубликован") expect(sql).toContain("when 'published_unverified' then 'Доставка не подтверждена'");
    }
  });

  it.each([
    ["published_unverified", "Опубликован, проверяется"],
    ["Опубликован, проверяется", "Опубликован, проверяется"],
    ["опубликован, проверяется", "опубликован, проверяется"],
    ["Доставка не подтверждена", "Опубликован, проверяется"],
  ])("replays historical unknown snapshot without rewriting bytes for %s", async (filter, historicalFilter) => {
    const request = { projectId: 7, kind: "content_plan", format: "csv",
      period: { from: "2026-08-01", to: "2026-08-31" },
      filters: { channel: [], author: [], campaign: [], status: [historicalFilter] } };
    const snapshot = createProjectExportSnapshot({ kind: "content_plan",
      exportedAt: "2026-08-11T12:00:00.000Z", project: { id: 7, name: "Проект", timezone: "UTC" },
      period: request.period, filters: request.filters,
      rows: [{ id: "legacy:51", projectId: 7, scheduledAt: "2026-08-11T10:00:00.000Z", channel: "Канал", title: "Старый снимок", status: "Опубликован, проверяется" }] });
    const stored = operationRow(snapshot, { request_hash: projectExportHash(request) });
    const originalJson = JSON.stringify(stored);
    const originalCsv = renderProjectCsv(snapshot);
    const pool = { query: vi.fn(async (sql: string) => {
      if (sql.includes("from project_export_operations")) return { rows: [stored] };
      throw new Error("historical replay must not read current source rows");
    }), connect: vi.fn() };
    const result = await createProjectExportOperation({ pool: pool as never, actorUserId: 9,
      requestKey: "legacy-unknown-001", body: { kind: "content_plan", format: "csv",
        period: request.period, filters: { status: filter }, previewHash: "b".repeat(64) } });
    expect(result).toMatchObject({ replayed: true, snapshotHash: projectExportHash(snapshot) });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(stored)).toBe(originalJson);
    expect(renderProjectCsv(snapshot)).toEqual(originalCsv);
  });

  it("does not alias a confirmed status into the unknown operation identity", async () => {
    const request = { projectId: 7, kind: "content_plan", format: "csv",
      period: { from: "2026-08-01", to: "2026-08-31" },
      filters: { channel: [], author: [], campaign: [], status: ["Опубликован, проверяется"] } };
    const snapshot = createProjectExportSnapshot({ kind: "content_plan", exportedAt: "2026-08-11T12:00:00.000Z",
      project: { id: 7, name: "Проект", timezone: "UTC" }, period: request.period, rows: [] });
    const pool = { query: vi.fn(async () => ({ rows: [operationRow(snapshot, { request_hash: projectExportHash(request) })] })), connect: vi.fn() };
    await expect(createProjectExportOperation({ pool: pool as never, actorUserId: 9, requestKey: "legacy-unknown-001",
      body: { kind: "content_plan", format: "csv", period: request.period,
        filters: { status: "published" }, previewHash: "b".repeat(64) } })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects a client-supplied SQL snapshot marker or rows before reading data", async () => {
    const db = { query: vi.fn() };
    for (const extra of [{ schemaVersion: "aurora-project-export-sql-selection-v2" }, { rows: [] }]) {
      await expect(previewProjectExport({ db: db as never, actorUserId: 9,
        body: { kind: "content_plan", format: "csv", period: { from: "2026-08-01", to: "2026-08-31" }, ...extra },
      })).rejects.toMatchObject({ code: "invalid_export_request", status: 400 });
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it("creates one immutable project-scoped operation and durable outbox row", async () => {
    let insertedSnapshot: Record<string, unknown> | null = null;
    const client = transactionClient((sql, values) => {
      if (sql.includes("from project_export_operations") && sql.includes("request_key")) return { rows: [] };
      if (sql.includes("insert into project_export_operations")) {
        insertedSnapshot = JSON.parse(String(values[7])) as Record<string, unknown>;
        return {
          rows: [operationRow(insertedSnapshot, {
            request_hash: values[5],
            snapshot_hash: values[8],
          })],
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        if (sql.includes("from project_export_operations") && sql.includes("request_key")) return { rows: [] };
        if (sql.includes("from projects")) return { rows: [{ id: 7, name: "Проект", timezone: "Europe/Amsterdam" }] };
        if (sql.includes("from posts post")) {
          expect(sql).toContain("where post.project_id = $1");
          expect(sql.indexOf("lower(btrim(")).toBeLessThan(sql.indexOf("limit $6"));
          expect(values).toEqual([
            7,
            "Europe/Amsterdam",
            "2026-08-01",
            "2026-08-31",
            ["Запланирован"],
            25_001,
          ]);
          return { rows: [sourceRow()] };
        }
        if (sql.includes("from monthly_campaign_items item")) {
          expect(sql.indexOf("lower(btrim(")).toBeLessThan(sql.indexOf("limit $6"));
          expect(sql).toContain("not exists (");
          expect(sql).toContain("newer.project_id = plan.project_id");
          expect(sql).toContain("newer.campaign_id = plan.campaign_id");
          expect(sql).toContain("newer.revision > plan.revision");
          expect(values).toEqual([
            7,
            "Europe/Amsterdam",
            "2026-08-01",
            "2026-08-31",
            ["Запланирован"],
            25_001,
          ]);
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      connect: vi.fn(async () => client),
    };

    const body = {
      kind: "content_plan" as const,
      format: "csv" as const,
      period: { from: "2026-08-01", to: "2026-08-31" },
      filters: { status: "scheduled" },
    };
    const preview = await previewProjectExport({
      db: pool as never,
      actorUserId: 9,
      body,
    });

    const result = await createProjectExportOperation({
      pool: pool as never,
      actorUserId: 9,
      requestKey: "export-test-001",
      body: { ...body, previewHash: preview.previewHash },
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    });

    expect(result).toMatchObject({ id: 41, projectId: 7, replayed: false, dispatch: "sync" });
    expect(insertedSnapshot).toMatchObject({
      project: { id: "7", timezone: "Europe/Amsterdam" },
      filters: { projectId: "7", status: ["Запланирован"] },
      rows: [{ projectId: "7", status: "Запланирован", channel: "ТехнологИИ Права" }],
    });
    const sql = client.query.mock.calls.map(([query]) => String(query)).join("\n");
    expect(sql).toContain("insert into project_export_outbox");
    expect(sql).toContain("insert into audit_events");
  });

  it("replays an idempotent request before querying source rows", async () => {
    const request = {
      projectId: 7,
      kind: "content_plan",
      format: "csv",
      period: { from: "2026-08-01", to: "2026-08-31" },
      filters: { channel: [], author: [], campaign: [], status: [] },
    };
    const snapshot = createProjectExportSnapshot({
      kind: "content_plan",
      exportedAt: "2026-08-11T12:00:00.000Z",
      project: { id: 7, name: "Проект", timezone: "UTC" },
      period: request.period,
      rows: [],
    });
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from project_export_operations")) {
          return { rows: [operationRow(snapshot, { request_hash: projectExportHash(request) })] };
        }
        throw new Error("source query must not run");
      }),
      connect: vi.fn(),
    };
    const result = await createProjectExportOperation({
      pool: pool as never,
      actorUserId: 9,
      requestKey: "export-test-002",
      body: {
        kind: "content_plan",
        format: "csv",
        period: request.period,
        previewHash: "b".repeat(64),
      },
    });
    expect(result.replayed).toBe(true);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("fails closed when an idempotency key is reused for another export", async () => {
    const snapshot = createProjectExportSnapshot({
      kind: "content_plan",
      exportedAt: "2026-08-11T12:00:00.000Z",
      project: { id: 7, name: "Проект", timezone: "UTC" },
      period: { from: "2026-08-01", to: "2026-08-31" },
      rows: [],
    });
    const pool = {
      query: vi.fn(async () => ({ rows: [operationRow(snapshot, { request_hash: "f".repeat(64) })] })),
      connect: vi.fn(),
    };
    await expect(createProjectExportOperation({
      pool: pool as never,
      actorUserId: 9,
      requestKey: "export-test-003",
      body: {
        kind: "content_plan",
        format: "csv",
        period: { from: "2026-08-01", to: "2026-08-31" },
        previewHash: "b".repeat(64),
      },
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("applies every content-plan dimension in SQL before the bounded read", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        if (sql.includes("from projects")) {
          return { rows: [{ id: 7, name: "Проект", timezone: "Europe/Amsterdam" }] };
        }
        if (sql.includes("from posts post") || sql.includes("from monthly_campaign_items item")) {
          queries.push({ sql, values });
          return { rows: sql.includes("from posts post") ? [sourceRow()] : [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const preview = await previewProjectExport({
      db: pool as never,
      actorUserId: 9,
      body: {
        kind: "content_plan",
        format: "xlsx",
        period: { from: "2026-08-01", to: "2026-08-31" },
        filters: {
          channel: "ТехнологИИ Права",
          author: "Анна",
          campaign: "Август",
          status: "scheduled",
        },
      },
    });
    expect(preview).toMatchObject({ rowCount: 1, exceedsLimit: false });
    expect(preview.sample[0]).toMatchObject({
      channel: "ТехнологИИ Права",
      author: "Анна",
      campaign: "Август",
      status: "Запланирован",
    });
    expect(queries).toHaveLength(2);
    for (const { sql, values } of queries) {
      expect(sql.match(/= any\(array\(/gu)).toHaveLength(4);
      expect(sql.match(/collate pg_catalog.pg_c_utf8/gu)).toHaveLength(8);
      expect(sql).toContain("lower(btrim(normalize(filter_value, NFKC)) collate pg_catalog.pg_c_utf8)");
      expect(sql.indexOf("from unnest($8::text[])")).toBeLessThan(sql.indexOf("limit $9"));
      expect(values).toEqual([
        7,
        "Europe/Amsterdam",
        "2026-08-01",
        "2026-08-31",
        ["ТехнологИИ Права"],
        ["Анна"],
        ["Август"],
        ["Запланирован"],
        25_001,
      ]);
    }
  });

  it("applies analytics dimensions before LIMIT and returns only project-bound rows", async () => {
    mocks.requireSelectedProjectPermission.mockResolvedValueOnce({
      projectId: 99,
      userId: 9,
      role: "owner",
      version: 1,
    });
    let analyticsSql = "";
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        if (sql.includes("from projects")) {
          expect(values).toEqual([99]);
          return { rows: [{ id: 99, name: "Изолированный проект", timezone: "UTC" }] };
        }
        if (sql.includes("from posts post")) {
          analyticsSql = sql;
          expect(values[0]).toBe(99);
          expect(values.at(-1)).toBe(25_001);
          return {
            rows: [
              { ...sourceRow(), project_id: "99", status: "confirmed", occurred_at: "2026-08-11T10:00:00.000Z" },
              { ...sourceRow(), id: "foreign", project_id: "7", status: "confirmed", occurred_at: "2026-08-11T11:00:00.000Z" },
            ],
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const preview = await previewProjectExport({
      db: pool as never,
      actorUserId: 9,
      body: {
        kind: "analytics",
        format: "pdf",
        period: { from: "2026-08-01", to: "2026-08-31" },
        filters: {
          channel: "ТехнологИИ Права",
          author: "Анна",
          campaign: "Август",
          status: "confirmed",
        },
      },
    });
    expect(analyticsSql.match(/= any\(array\(/gu)).toHaveLength(4);
    expect(analyticsSql.indexOf("from unnest($8::text[])")).toBeLessThan(analyticsSql.indexOf("limit $9"));
    expect(preview.rowCount).toBe(1);
    expect(preview.sample).toHaveLength(1);
    expect(preview.sample[0]?.id).toBe("51");
  });

  it("requires the exact current server preview before creating an operation", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from project_export_operations")) return { rows: [] };
        if (sql.includes("from projects")) return { rows: [{ id: 7, name: "Проект", timezone: "UTC" }] };
        if (sql.includes("from posts post")) return { rows: [sourceRow()] };
        if (sql.includes("from monthly_campaign_items item")) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
      connect: vi.fn(),
    };
    await expect(createProjectExportOperation({
      pool: pool as never,
      actorUserId: 9,
      requestKey: "export-preview-stale",
      body: {
        kind: "content_plan",
        format: "csv",
        period: { from: "2026-08-01", to: "2026-08-31" },
        previewHash: "f".repeat(64),
      },
    })).rejects.toMatchObject({ code: "preview_stale", status: 409 });
    expect(pool.connect).not.toHaveBeenCalled();

    await expect(createProjectExportOperation({
      pool: pool as never,
      actorUserId: 9,
      requestKey: "export-preview-missing",
      body: {
        kind: "content_plan",
        format: "csv",
        period: { from: "2026-08-01", to: "2026-08-31" },
      },
    })).rejects.toMatchObject({ code: "preview_required", status: 409 });
  });

  it("mints a short-lived raw token but persists only its hash", async () => {
    const pool = {
      query: vi.fn(async (sql: string, values: unknown[] = []) => {
        if (sql.includes("select artifact.id")) {
          expect(values.slice(0, 3)).toEqual([41, 7, 9]);
          return { rows: [{ id: 81, expires_at: "2026-08-12T12:00:00.000Z" }] };
        }
        if (sql.includes("insert into project_export_download_tokens")) return { rows: [], rowCount: 1 };
        throw new Error(`unexpected query: ${sql}`);
      }),
      connect: vi.fn(),
    };
    const result = await createProjectExportDownloadToken({
      pool: pool as never,
      actorUserId: 9,
      operationId: 41,
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    });
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.expiresAt).toBe("2026-08-11T12:15:00.000Z");
    const insert = pool.query.mock.calls.find(([sql]) => String(sql).includes("insert into project_export_download_tokens"));
    expect(insert?.[1]?.[3]).toBe(projectExportHash(result.token));
    expect(insert?.[1]).not.toContain(result.token);
  });

  it("resolves bytes only through operation, selected project, actor and token", async () => {
    const data = Buffer.from("safe export", "utf8");
    const client = transactionClient((sql, values) => {
      if (sql.includes("from project_export_download_tokens")) {
        expect(sql).toContain("operation.project_id = $2");
        expect(sql).toContain("operation.requested_by_user_id = $3");
        expect(sql).toContain("token.requested_by_user_id = $3");
        expect(values.slice(0, 3)).toEqual([41, 7, 9]);
        return { rows: [{ token_id: 3, file_name: "report.csv", mime_type: "text/csv", byte_size: data.length,
          storage_backend: "postgres", data }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const pool = { query: vi.fn(), connect: vi.fn(async () => client) };
    const result = await resolveProjectExportDownload({
      pool: pool as never,
      actorUserId: 9,
      operationId: 41,
      token: "A".repeat(43),
      now: () => new Date("2026-08-11T12:00:00.000Z"),
    });
    expect(result.bytes).toEqual(data);
    expect(result.fileName).toBe("report.csv");
  });

  it("never returns an operation from another selected project", async () => {
    mocks.requireSelectedProjectPermission.mockResolvedValueOnce({ projectId: 99, userId: 9, role: "owner", version: 1 });
    const pool = {
      query: vi.fn(async (_sql: string, values: unknown[]) => {
        expect(values).toEqual([41, 99, 9]);
        return { rows: [] };
      }),
    };
    await expect(getProjectExportOperation(pool as never, 9, 41)).rejects.toBeInstanceOf(ProjectExportServiceError);
  });

  it("queues row-heavy snapshots", () => {
    const snapshot = { rows: Array.from({ length: 501 }, () => ({})) } as never;
    expect(shouldQueueProjectExport(snapshot)).toBe(true);
  });
});
