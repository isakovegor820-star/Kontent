import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { assertFutureProviderAdapter } from "./social-provider-contract.mjs";
import { createTenChatExportPackage, TENCHAT_ADAPTER } from "./tenchat-adapter.mjs";

const exportedAt = "2026-08-11T10:00:00.000Z";

describe("TenChat contract-ready export-only adapter", () => {
  it("fails live publishing closed without network I/O or a false success", async () => {
    expect(assertFutureProviderAdapter(TENCHAT_ADAPTER)).toBe(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(TENCHAT_ADAPTER.publish({ text: "Пост" })).resolves.toMatchObject({
      ok: false,
      outcome: "definite_failure",
      reason: "official_access_required",
      code: "tenchat_official_access_required",
      retryable: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("creates a deterministic checked package with text, manifest and verified media", () => {
    const image = Buffer.from("fake-png-for-contract-test", "utf8");
    const input = {
      projectName: "ТехнологИИ Права",
      text: "Пять действий для проверки договора",
      exportedAt,
      scheduledAt: "2026-08-12T09:00:00.000Z",
      assets: [{
        fileName: "карточка 1.png",
        mimeType: "image/png",
        sha256: createHash("sha256").update(image).digest("hex"),
        data: image,
      }],
    };
    const first = createTenChatExportPackage(input);
    const second = createTenChatExportPackage(input);
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(first.filename).toBe("ТехнологИИ-Права-tenchat-package.zip");
    expect(first.manifest).toMatchObject({
      mode: "export_only",
      livePublishing: false,
      officialAccessRequired: true,
      manualPublishRequired: true,
      providerLimitsVerified: false,
      mediaCompatibilityVerified: false,
      checkedAt: "2026-08-12",
      assets: [{ mimeType: "image/png", bytes: image.length }],
    });
    expect(first.bytes.includes(Buffer.from("Аврора не отправляла этот материал"))).toBe(true);
    expect(first.bytes.includes(Buffer.from("Пять действий для проверки договора"))).toBe(true);
  });

  it("rejects invalid schedule metadata instead of emitting a misleading manifest", () => {
    expect(() => createTenChatExportPackage({
      projectName: "Проект",
      text: "Пост",
      exportedAt,
      scheduledAt: "not-a-date",
    })).toThrow("tenchat_scheduled_at_invalid");
  });

  it("rejects altered media and contains no private or browser-automation implementation", async () => {
    expect(() => createTenChatExportPackage({
      projectName: "Проект",
      text: "Пост",
      exportedAt,
      assets: [{ fileName: "x", mimeType: "image/png", sha256: "0".repeat(64), data: Buffer.from("changed") }],
    })).toThrow("tenchat_asset_0_hash_mismatch");
    const source = await readFile(new URL("./tenchat-adapter.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/puppeteer|playwright|graphql|private[_-]?api|tenchat\.ru\/api/iu);
  });
});
