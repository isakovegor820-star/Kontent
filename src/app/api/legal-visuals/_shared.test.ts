import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { LEGAL_STUDIO_JSON_BODY_MAX_BYTES, legalStudioBody } from "./_shared";

describe("legal studio JSON ingress", () => {
  it("requires exact JSON and a top-level allowlist", async () => {
    await expect(legalStudioBody(new Request("https://aurora.test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }), [])).resolves.toEqual({ ok: false, error: "unsupported_media_type" });
    await expect(legalStudioBody(new Request("https://aurora.test", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ expectedRevision: 2, projectId: 999 }),
    }), ["expectedRevision"])).resolves.toEqual({ ok: false, error: "bad_request" });
  });

  it("measures the actual stream and rejects malformed UTF-8", async () => {
    await expect(legalStudioBody(new Request("https://aurora.test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2" },
      body: JSON.stringify({ config: "x".repeat(LEGAL_STUDIO_JSON_BODY_MAX_BYTES) }),
    }), ["config"])).resolves.toEqual({ ok: false, error: "payload_too_large" });
    await expect(legalStudioBody(new Request("https://aurora.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
    }), ["x"])).resolves.toEqual({ ok: false, error: "bad_request" });
  });

  it("keeps every legal visual, video and brand mutation on the shared bounded reader", async () => {
    const routes = [
      "src/app/api/legal-visuals/route.ts",
      "src/app/api/legal-visuals/[id]/route.ts",
      "src/app/api/legal-visuals/[id]/renders/route.ts",
      "src/app/api/legal-visuals/brand-kit/route.ts",
      "src/app/api/legal-video-scripts/route.ts",
      "src/app/api/legal-video-scripts/[id]/route.ts",
    ];
    for (const route of routes) {
      const source = await readFile(resolve(process.cwd(), route), "utf8");
      expect(source, route).toContain("legalStudioBody(");
      expect(source, route).toContain("legalStudioBodyFailure");
      expect(source, route).not.toContain("request.json(");
    }
  });
});
