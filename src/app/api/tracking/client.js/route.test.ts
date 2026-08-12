import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { TRACKING_CLIENT_SOURCE } from "@/lib/tracking-client-source";
import { GET } from "./route";

describe("first-party tracking client", () => {
  it("serves an immutable public script without credentials or attribution leakage", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const source = await response.text();
    expect(source).toContain('credentials: "omit"');
    expect(source).toContain('referrerPolicy: "no-referrer"');
    expect(source).toContain('pageUrl.searchParams.delete("aurora_attribution")');
    expect(source).not.toContain("document.cookie");
  });

  it("exposes only the three documented conversion events with idempotency", () => {
    expect(TRACKING_CLIENT_SOURCE).toContain('"form_open", "form_submit", "consultation_booked"');
    expect(TRACKING_CLIENT_SOURCE).toContain('headers["idempotency-key"]');
    expect(TRACKING_CLIENT_SOURCE).not.toContain("sessionStorage");
    expect(TRACKING_CLIENT_SOURCE).toContain('Object.freeze(client)');
    expect(TRACKING_CLIENT_SOURCE).not.toContain("innerHTML");
  });

  it("creates a fresh key for each independent event and preserves an explicit replay key", async () => {
    const requests: Array<{ path: string; key: string | null }> = [];
    const storage = new Map([["aurora:attribution:tracker_public_key_1234567890", "token.payload"]]);
    let sequence = 0;
    const location = new URL("https://law.example.ru/consultation");
    const window = {
      location,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
      },
      history: { state: null, replaceState() {} },
    } as Record<string, unknown>;
    const context = {
      URL,
      Date,
      Object,
      Set,
      Promise,
      window,
      document: {
        baseURI: "https://law.example.ru/",
        currentScript: {
          src: "https://aurora.example/api/tracking/client.js",
          getAttribute: (name: string) => name === "data-project-key" ? "tracker_public_key_1234567890" : null,
        },
      },
      crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` },
      fetch: async (url: string, init: { headers?: Record<string, string> }) => {
        requests.push({ path: new URL(url).pathname, key: init.headers?.["idempotency-key"] ?? null });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    };
    vm.runInNewContext(TRACKING_CLIENT_SOURCE, context);
    const client = window.AuroraTracking as {
      ready: Promise<unknown>;
      track: (event: string, key?: string) => Promise<unknown>;
    };
    await client.ready;
    await client.track("form_submit");
    await client.track("form_submit");
    await client.track("consultation_booked", "consultation:12345678");
    await client.track("consultation_booked", "consultation:12345678");

    const conversionKeys = requests
      .filter((request) => request.path === "/api/tracking/conversions")
      .map((request) => request.key);
    expect(conversionKeys[0]).toMatch(/^event:/u);
    expect(conversionKeys[1]).toMatch(/^event:/u);
    expect(conversionKeys[0]).not.toBe(conversionKeys[1]);
    expect(conversionKeys.slice(2)).toEqual(["consultation:12345678", "consultation:12345678"]);
  });
});
