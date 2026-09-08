import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJson } from "./client";

afterEach(() => vi.unstubAllGlobals());
describe("site requests", () => {
  it.each(["disconnect", "invalid_json"])("returns a recoverable failure on %s without repeating a mutation", async (failure) => {
    const fetch = vi.fn(async () => {
      if (failure === "disconnect") throw new TypeError("Failed to fetch");
      return new Response("<html>gateway error</html>");
    });
    vi.stubGlobal("fetch", fetch);
    expect(await requestJson("/api/sites/5/articles", { method: "POST", body: "{}" }))
      .toEqual({ status: 503, body: { error: "request_unconfirmed" } });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
