import { describe, expect, it, vi } from "vitest";

import {
  CONSENT_KINDS,
  CONSENT_TEXT_VERSION,
  POLICY_VERSION,
  isConsentRequired,
  parseConsentFlag,
  recordConsent,
} from "./consent";

describe("consent contract", () => {
  it("accepts only an explicit boolean as consent", () => {
    expect(parseConsentFlag(true)).toEqual({ ok: true, granted: true });
    expect(parseConsentFlag(false)).toEqual({ ok: true, granted: false });
    expect(parseConsentFlag(undefined)).toEqual({ ok: true, granted: false });
    expect(parseConsentFlag(null)).toEqual({ ok: true, granted: false });
  });

  it("rejects look-alike values instead of coercing them", () => {
    // Согласие — это действие пользователя, а не истинное значение в JS:
    // строка «true», число 1 и объект согласием не считаются.
    for (const value of ["true", 1, {}, [], "on"]) {
      expect(parseConsentFlag(value)).toEqual({ ok: false, error: "consent_required" });
    }
  });

  it("keeps the requirement switch off until the texts are approved", () => {
    expect(isConsentRequired({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isConsentRequired({ AURORA_CONSENT_REQUIRED: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(isConsentRequired({ AURORA_CONSENT_REQUIRED: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("covers the consent kinds the platform actually asks for", () => {
    expect([...CONSENT_KINDS]).toEqual(["pd_processing", "marketing", "pd_distribution", "cookie"]);
  });

  it("records a full evidence row, not just a flag", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await recordConsent({ query }, {
      userId: 42,
      kind: "pd_processing",
      granted: true,
      ip: "203.0.113.7",
      userAgent: "vitest",
      source: "register",
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("insert into consents");
    expect(values).toEqual([
      42,
      null,
      "pd_processing",
      true,
      "203.0.113.7",
      "vitest",
      POLICY_VERSION,
      CONSENT_TEXT_VERSION,
      "register",
    ]);
  });

  it("records a revocation as a new row rather than a rewrite", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await recordConsent({ query }, { contact: "test@example.com", kind: "marketing", granted: false, source: "lead" });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    // Журнал append-only: отзыв — вставка, а не update или delete.
    expect(sql).toContain("insert into consents");
    expect(sql).not.toMatch(/\bupdate\b|\bdelete\b/iu);
    expect(values).toContain(false);
  });

  it("does not swallow a failed write", async () => {
    const query = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      recordConsent({ query }, { kind: "pd_processing", granted: true, source: "register" }),
    ).rejects.toThrow("db down");
  });
});
