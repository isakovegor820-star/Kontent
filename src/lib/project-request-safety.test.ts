import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
const scope = new AsyncLocalStorage<Headers>();
vi.mock("next/headers", () => ({ headers: async () => scope.getStore() ?? new Headers() }));
import { requireSelectedProjectPermission } from "./project-permissions";

describe("request project identity", () => {
  it("keeps tab A reads on A after tab B changes the user preference", async () => {
    const db = { query: vi.fn(async (sql: string, params: unknown[]) => ({ rows: [{
      project_id: sql.includes("from user_project_preferences") ? 22 : params[0],
      user_id: 7, role: "owner", version: 1,
    }] })) };
    const membership = await scope.run(new Headers({ "x-aurora-project-id": "11" }), () => requireSelectedProjectPermission(db as never, 7, "project.read"));
    expect(membership.projectId).toBe(11);
  });
  it("refuses a malformed explicit selector instead of falling back to another project", async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ project_id: 22, user_id: 7, role: "owner", version: 1 }] })) };
    await expect(scope.run(new Headers({ "x-aurora-project-id": "0" }), () => requireSelectedProjectPermission(db as never, 7, "project.read")))
      .rejects.toMatchObject({ code: "invalid_project_selector" });
    expect(db.query).not.toHaveBeenCalled();
  });
});
