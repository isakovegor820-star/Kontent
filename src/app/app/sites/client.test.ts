import { afterEach, expect, it, vi } from "vitest";
import { requestJson } from "./client";
afterEach(() => vi.unstubAllGlobals());

it("returns a failure on a lost mutation response without retrying the mutation", async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  vi.stubGlobal("fetch", fetch);
  await expect(requestJson("/api/sites/1/articles/2", { method: "POST", body: '{"action":"approve"}' }))
    .resolves.toMatchObject({ status: 503, body: { error: "network_unavailable" } });
  expect(fetch).toHaveBeenCalledOnce();
});

it("preserves API error status and version conflict details", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "article_version_conflict" }, { status: 409 })));
  await expect(requestJson("/api/sites/1/articles/2"))
    .resolves.toEqual({ status: 409, body: { error: "article_version_conflict" } });
});

it("does not turn an HTML proxy response into mutation success", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Proxy error</html>")));
  await expect(requestJson("/api/sites/1/articles/2", { method: "POST" }))
    .resolves.toMatchObject({ status: 503, body: { error: "network_unavailable" } });
});
