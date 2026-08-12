import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ permission: vi.fn() }));
vi.mock("./project-permissions", () => ({
  requireSelectedProjectPermission: mocks.permission,
}));

import {
  createProjectBrandDictionaryEntry,
  getProjectBrandDictionary,
} from "./brand-dictionary-service";

describe("brand dictionary service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permission.mockResolvedValue({ projectId: 23, userId: 5, role: "owner" });
  });

  it("reads only the server-selected project and maps all legal dictionary kinds", async () => {
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        expect(params).toEqual([23]);
        if (sql.includes("from project_brand_dictionaries")) {
          return { rows: [{ version: "7", updated_at: "2026-08-12T00:00:00.000Z" }] };
        }
        return {
          rows: [{
            id: "11",
            kind: "abbreviation",
            term: "Конституционный Суд Российской Федерации",
            replacement: "КС РФ",
            expansion: "Конституционный Суд Российской Федерации",
            case_sensitive: false,
            version: "2",
          }],
        };
      }),
    };
    const result = await getProjectBrandDictionary(db as never, 5);
    expect(mocks.permission).toHaveBeenCalledWith(db, 5, "project.read");
    expect(result).toEqual({
      projectId: 23,
      version: 7,
      updatedAt: "2026-08-12T00:00:00.000Z",
      entries: [{
        id: 11,
        kind: "abbreviation",
        term: "Конституционный Суд Российской Федерации",
        replacement: "КС РФ",
        expansion: "Конституционный Суд Российской Федерации",
        caseSensitive: false,
        version: 2,
      }],
    });
  });

  it("requires project.manage, locks the expected version and advances it atomically", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
        if (sql.includes("insert into project_brand_dictionaries")) return { rows: [] };
        if (sql.includes("select version") && sql.includes("for update")) return { rows: [{ version: "4" }] };
        if (sql.includes("insert into project_brand_dictionary_entries")) {
          return { rows: [{
            id: "12",
            kind: "canonical",
            term: "legal tech",
            replacement: "LegalTech",
            expansion: null,
            case_sensitive: false,
            version: "1",
          }] };
        }
        if (sql.includes("update project_brand_dictionaries")) {
          return { rows: [{ version: "5", updated_at: "2026-08-12T01:00:00.000Z" }] };
        }
        if (sql.includes("insert into audit_events")) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const result = await createProjectBrandDictionaryEntry({
      pool: pool as never,
      actorUserId: 5,
      expectedDictionaryVersion: 4,
      kind: "canonical",
      term: " legal   tech ",
      replacement: " LegalTech ",
      expansion: null,
      caseSensitive: false,
      requestId: "req-1",
    });

    expect(mocks.permission).toHaveBeenCalledWith(client, 5, "project.manage");
    expect(result).toMatchObject({ projectId: 23, dictionaryVersion: 5, entry: { term: "legal tech", replacement: "LegalTech" } });
    expect(client.query).toHaveBeenCalledWith("commit");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects a replacement on allowed and exception rules before database access", async () => {
    const pool = { connect: vi.fn() };
    await expect(createProjectBrandDictionaryEntry({
      pool: pool as never,
      actorUserId: 5,
      expectedDictionaryVersion: 1,
      kind: "allowed",
      term: "Legal Tech",
      replacement: "LegalTech",
      expansion: null,
      caseSensitive: false,
    })).rejects.toMatchObject({ code: "invalid_replacement" });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
