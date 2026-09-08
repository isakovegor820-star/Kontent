import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("./session", () => ({ getSessionUser: vi.fn(async () => ({ id: 7 })) }));
import { withProjectRoute } from "./project-route";
import { requireProjectPermission, requireSelectedProjectPermission } from "./project-permissions";

function request(project: string | null) {
  return new NextRequest("http://localhost/api/channels", { headers: project ? { "x-aurora-project-id": project } : {} });
}
const db = () => ({ query: vi.fn(async (_sql: string, values: unknown[]) => ({ rows: [
  { project_id: values[0], user_id: 7, role: "owner", version: 1 },
] })) });

describe("HTTP project selector boundary", () => {
  it("rejects absent and malformed selectors before the handler", async () => {
    const handle = vi.fn(async () => NextResponse.json({ ok: true }));
    const route = withProjectRoute(handle);
    expect((await route(request(null))).status).toBe(428);
    for (const invalid of ["0", "-1", "1.5", "1e2", "9007199254740992", "1,2"]) expect((await route(request(invalid))).status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });
  it("rejects contradictory selectors and malformed project object paths", async () => {
    const handle = vi.fn(async () => NextResponse.json({ ok: true }));
    const route = withProjectRoute(handle);
    for (const suffix of ["?projectId=22", "?projectId=11&projectId=22", "?projectId=0"]) {
      expect((await route(new NextRequest("http://localhost/api/channels" + suffix, { headers: { "x-aurora-project-id": "11" } }))).status).toBe(400);
    }
    const objectRoute = withProjectRoute(handle, { projectInPath: true });
    expect((await objectRoute(new NextRequest("http://localhost/api/projects/0"))).status).toBe(400);
    expect((await objectRoute(new NextRequest("http://localhost/api/projects/22", { headers: { "x-aurora-project-id": "11" } }))).status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });
  it("passes the captured selector into nested permission checks, never server preferences", async () => {
    const database = db();
    const route = withProjectRoute(async () => NextResponse.json(await requireSelectedProjectPermission(database as never, 7, "content.edit")));
    const response = await route(request("11"));
    expect((await response.json()).projectId).toBe(11);
    expect(response.headers.get("x-aurora-project-id")).toBe("11");
    expect(database.query.mock.calls[0][0]).not.toContain("user_project_preferences");
    expect(database.query.mock.calls[0][1]).toEqual([11, 7]);
  });
  it("does not mix simultaneous asynchronous request contexts", async () => {
    const database = db();
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const route = withProjectRoute(async (req) => {
      if (req.headers.get("x-aurora-project-id") === "11") await paused;
      return NextResponse.json(await requireSelectedProjectPermission(database as never, 7, "project.read"));
    });
    const a = route(request("11"));
    const b = await route(request("22"));
    resume();
    expect((await b.json()).projectId).toBe(22);
    expect((await (await a).json()).projectId).toBe(11);
  });
  it("rejects a foreign object project even when the actor has access to both", async () => {
    const database = db();
    const route = withProjectRoute(async () => {
      try { await requireProjectPermission(database as never, 7, 22, "content.publish"); }
      catch { return NextResponse.json({ error: "forbidden" }, { status: 403 }); }
      return NextResponse.json({ ok: true });
    });
    const response = await route(request("11"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "project_context_mismatch" });
    expect(database.query).not.toHaveBeenCalled();
  });
});
