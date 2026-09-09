import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
import { POST } from "./route";
import { hashSessionToken } from "@/lib/session";
function request(origin = "http://localhost") { return new NextRequest("http://localhost/api/auth/logout", { method: "POST", headers: { origin, cookie: "sid=n28-ephemeral-token" } }); }
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("APP_URL", "http://localhost"); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("logout durable revocation receipt", () => {
  it("never returns success or discards retry credential when PostgreSQL rejects revocation", async () => {
    mocks.query.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await POST(request());
    expect(mocks.query).toHaveBeenCalledWith("delete from sessions where token_hash = $1", [hashSessionToken("n28-ephemeral-token")]);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "logout_unavailable" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });
  it("only acknowledges after the hashed current session deletion completes", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const response = await POST(request()); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mocks.query).toHaveBeenCalledWith("delete from sessions where token_hash = $1", [hashSessionToken("n28-ephemeral-token")]);
  });
  it("permits a safe retry after the same current session was already removed", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const response = await POST(request()); expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
  });
  it("rejects a cross-origin logout before any session mutation", async () => {
    const response = await POST(request("https://foreign.example"));
    expect(response.status).toBe(403); expect(mocks.query).not.toHaveBeenCalled();
  });
});
