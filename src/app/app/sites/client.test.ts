import { afterEach, describe, expect, it, vi } from "vitest";

import { requestJson } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("site requests", () => {
  it("returns an unconfirmed result on transport loss without repeating a mutation", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("connection lost"); });
    vi.stubGlobal("fetch", fetch);
    await expect(requestJson("/api/sites/1/destinations", { method: "PUT", body: "{}" }))
      .resolves.toEqual({ status: 503, body: { error: "result_unconfirmed" } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["", "<html>gateway</html>", "null", "[]", "{}", '{"ok":false}'])(
    "never treats malformed successful payload %s as an accepted action",
    async (body) => {
      const fetch = vi.fn(async () => new Response(body, { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      await expect(requestJson("/api/sites/1/articles/1", { method: "POST", body: "{}" }))
        .resolves.toEqual({ status: 502, body: { error: "result_unconfirmed" } });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("keeps explicit server errors and valid successful payloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "access_denied" }, { status: 403 })));
    await expect(requestJson("/api/sites")).resolves.toEqual({ status: 403, body: { error: "access_denied" } });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, site: { id: 1 } })));
    await expect(requestJson("/api/sites/1", { method: "PATCH", body: "{}" }))
      .resolves.toEqual({ status: 200, body: { ok: true, site: { id: 1 } } });
  });
});
