import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { readTrackingBodyResult, TRACKING_JSON_BODY_MAX_BYTES } from "./_shared";

function request(body: BodyInit, contentType = "application/json") {
  return new Request("http://localhost/api/tracking/test", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

describe("tracking JSON ingress", () => {
  it("accepts only JSON objects with explicit top-level keys", async () => {
    await expect(readTrackingBodyResult(
      request(JSON.stringify({ expectedVersion: 2 }), "application/json; charset=utf-8"),
      ["expectedVersion"],
    )).resolves.toEqual({ ok: true, body: { expectedVersion: 2 } });
    await expect(readTrackingBodyResult(
      request(JSON.stringify({ expectedVersion: 2, projectId: 99 })),
      ["expectedVersion"],
    )).resolves.toEqual({ ok: false, error: "bad_request" });
    await expect(readTrackingBodyResult(request("{}", "text/plain"), [])).resolves.toEqual({
      ok: false,
      error: "unsupported_media_type",
    });
  });

  it("counts the actual stream and decodes UTF-8 fatally despite a lying Content-Length", async () => {
    const oversized = new Request("http://localhost/api/tracking/test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2" },
      body: JSON.stringify({ padding: "x".repeat(TRACKING_JSON_BODY_MAX_BYTES + 1) }),
    });
    await expect(readTrackingBodyResult(oversized, ["padding"])).resolves.toEqual({
      ok: false,
      error: "payload_too_large",
    });
    await expect(readTrackingBodyResult(
      request(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d]) as BodyInit),
      ["x"],
    )).resolves.toEqual({ ok: false, error: "bad_request" });
  });

  it("keeps every authenticated tracking mutation on an explicit allowlist", async () => {
    const routes = [
      "settings/route.ts",
      "settings/verify/route.ts",
      "templates/route.ts",
      "templates/[id]/route.ts",
      "links/route.ts",
      "links/[id]/route.ts",
    ];
    for (const route of routes) {
      const source = await readFile(new URL(route, import.meta.url), "utf8");
      expect(source, route).toMatch(/readTrackingBodyResult\(req, \[[\s\S]*?\]\)/u);
      expect(source, route).not.toContain("req.json(");
    }
  });
});
