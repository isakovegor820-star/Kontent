import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const requestScope = new AsyncLocalStorage<Headers>();
vi.mock("next/headers", () => ({ headers: async () => requestScope.getStore() ?? new Headers() }));
import { requireProjectPermission, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { getSelectedProjectContext, selectProjectForUser } from "@/lib/project-context";
import { listProjectsForUser } from "@/lib/project-team";

const databaseUrl = String(process.env.PROJECT_CONTEXT_TEST_DATABASE_URL || "");
const target = new URL(databaseUrl);
if (!["127.0.0.1","localhost","::1"].includes(target.hostname) || target.pathname !== "/aurora_d02_test") throw new Error("Requires disposable local aurora_d02_test database");
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 8 });
let userId: number, a: number, b: number;
function tab<T>(projectId: number, work: () => Promise<T>): Promise<T> {
  return requestScope.run(new Headers({ "x-aurora-project-id": String(projectId) }), work);
}
beforeAll(async () => {
  await pool.query("drop schema public cascade"); await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  userId = Number((await pool.query("insert into users(email) values ('two-tabs@fixture.test') returning id")).rows[0].id);
  [a,b] = (await pool.query("insert into projects(name,created_by_user_id) values ('A',$1),('B',$1) returning id",[userId])).rows.map((r) => Number(r.id));
  await pool.query("insert into project_members(project_id,user_id,role) values ($1,$3,'owner'),($2,$3,'owner')",[a,b,userId]);
  await selectProjectForUser(pool,userId,a);
});
afterAll(async () => { await pool.end(); });

describe("two tab project contract with real PostgreSQL", () => {
  it("retains independent read/context/list selection after another tab switches", async () => {
    await tab(a, () => selectProjectForUser(pool,userId,b));
    const [aPermission,bPermission,aContext,bContext,aList,bList] = await Promise.all([
      tab(a,() => requireSelectedProjectPermission(pool,userId,"project.read")),
      tab(b,() => requireSelectedProjectPermission(pool,userId,"project.read")),
      tab(a,() => getSelectedProjectContext(pool,userId)),
      tab(b,() => getSelectedProjectContext(pool,userId)),
      tab(a,() => listProjectsForUser(pool,userId)),
      tab(b,() => listProjectsForUser(pool,userId)),
    ]);
    expect([aPermission.projectId,aContext.projectId,aList.find((p) => p.selected)?.id]).toEqual([a,a,a]);
    expect([bPermission.projectId,bContext.projectId,bList.find((p) => p.selected)?.id]).toEqual([b,b,b]);
  });
  it("writes into the initiating tab's selected project despite concurrent global selection change", async () => {
    await selectProjectForUser(pool,userId,b);
    await tab(a,async () => {
      const permission = await requireSelectedProjectPermission(pool,userId,"project.manage");
      await pool.query("update projects set name = 'A edited by tab A' where id = $1",[permission.projectId]);
    });
    expect((await pool.query("select name from projects where id = $1",[a])).rows[0].name).toBe("A edited by tab A");
    expect((await pool.query("select name from projects where id = $1",[b])).rows[0].name).toBe("B");
  });
  it("refuses explicit object target from a different project even for an owner of both", async () => {
    await expect(tab(a,() => requireProjectPermission(pool,userId,b,"content.edit"))).rejects.toMatchObject({ code: "invalid_project_selector" });
  });
  it("does not fall back to B after membership A is revoked", async () => {
    await pool.query("update project_members set status = 'revoked', revoked_at = now() where user_id = $1 and project_id = $2",[userId,a]);
    await expect(tab(a,() => requireSelectedProjectPermission(pool,userId,"project.read"))).rejects.toMatchObject({ code: "membership_required" });
    await expect(tab(a,() => getSelectedProjectContext(pool,userId))).rejects.toMatchObject({ code: "membership_required" });
    expect((await tab(a,() => listProjectsForUser(pool,userId))).filter((p) => p.selected)).toHaveLength(0);
    expect((await tab(b,() => requireSelectedProjectPermission(pool,userId,"project.read"))).projectId).toBe(b);
  });
});
