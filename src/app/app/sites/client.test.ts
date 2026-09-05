import { afterEach, expect, it, vi } from "vitest";
import { requestJson } from "./client";
afterEach(() => vi.unstubAllGlobals());
it("returns an unconfirmed result on transport loss so mutation callers leave the busy state", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connection lost"); }));
  await expect(requestJson("/api/sites/1/destinations", { method: "PUT", body: "{}" }))
    .resolves.toEqual({ status: 503, body: { error: "result_unconfirmed" } });
});
it.each(["", "<html>gateway</html>", "null", "[]", "{}", '{"ok":false}'])("never treats malformed successful payload %s as an accepted action", async (body) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
  await expect(requestJson("/api/sites/1/articles/1", { method: "POST", body: "{}" }))
    .resolves.toEqual({ status: 502, body: { error: "result_unconfirmed" } });
});
it("keeps explicit server errors and valid successful payloads", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "access_denied" }, { status: 403 })));
  expect(await requestJson("/api/sites")).toEqual({ status: 403, body: { error: "access_denied" } });
});
