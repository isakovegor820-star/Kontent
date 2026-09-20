import { describe, expect, it, vi } from "vitest";

import {
  generateSiteVerificationToken,
  htmlContainsVerificationMeta,
  isSiteVerificationToken,
  siteVerificationInstructions,
  txtRecordsContainToken,
  verifySiteOwnership,
} from "./verification";

const token = "abcdefghijklmnopqrstuvwxyz0123456789_-AB";
const site = { confirmedDomain: "example.ru", canonicalUrl: "https://example.ru/", verificationToken: token };

describe("site verification primitives", () => {
  it("generates url-safe tokens of sufficient length", () => {
    const generated = generateSiteVerificationToken();
    expect(isSiteVerificationToken(generated)).toBe(true);
    expect(generated).not.toBe(generateSiteVerificationToken());
    expect(isSiteVerificationToken("short")).toBe(false);
    expect(isSiteVerificationToken("has space in it and is long enough to pass")).toBe(false);
  });

  it("builds DNS and meta instructions from the token", () => {
    const instructions = siteVerificationInstructions("example.ru", token);
    expect(instructions.dns).toEqual({ recordName: "_aurora-site.example.ru", recordType: "TXT", recordValue: token });
    expect(instructions.meta.tag).toBe(`<meta name="aurora-site-verification" content="${token}">`);
  });

  it("matches TXT records by joined chunks and exact value", () => {
    expect(txtRecordsContainToken([["other"], [token.slice(0, 10), token.slice(10)]], token)).toBe(true);
    expect(txtRecordsContainToken([[` ${token} `]], token)).toBe(true);
    expect(txtRecordsContainToken([[`${token}x`]], token)).toBe(false);
    expect(txtRecordsContainToken("not-array", token)).toBe(false);
  });

  it("finds the meta tag regardless of attribute order and quoting", () => {
    expect(htmlContainsVerificationMeta(`<html><head><meta content='${token}' name=aurora-site-verification></head></html>`, token)).toBe(true);
    expect(htmlContainsVerificationMeta(`<meta name="AURORA-SITE-VERIFICATION" content="${token}" />`, token)).toBe(true);
    expect(htmlContainsVerificationMeta(`<meta name="aurora-site-verification" content="${token}wrong">`, token)).toBe(false);
    expect(htmlContainsVerificationMeta(`<p>${token}</p>`, token)).toBe(false);
    expect(htmlContainsVerificationMeta(`<meta name="description" content="${token}">`, token)).toBe(false);
  });
});

describe("verifySiteOwnership", () => {
  it("prefers DNS and reports the method that matched", async () => {
    const resolveTxt = vi.fn(async () => [[token]]);
    const fetchText = vi.fn(async () => "<html></html>");
    await expect(verifySiteOwnership(site, "auto", { resolveTxt, fetchText })).resolves.toEqual({ ok: true, method: "dns_txt" });
    expect(resolveTxt).toHaveBeenCalledWith("_aurora-site.example.ru");
    expect(fetchText).not.toHaveBeenCalled();
  });

  it("falls back to the meta tag when DNS has no record", async () => {
    const resolveTxt = vi.fn(async () => { throw Object.assign(new Error("no data"), { code: "ENODATA" }); });
    const fetchText = vi.fn(async () => `<head><meta name="aurora-site-verification" content="${token}"></head>`);
    await expect(verifySiteOwnership(site, "auto", { resolveTxt, fetchText })).resolves.toEqual({ ok: true, method: "meta_tag" });
    expect(fetchText).toHaveBeenCalledWith("https://example.ru/");
  });

  it("explains a mismatch over a missing record and never throws on network failures", async () => {
    const resolveTxt = vi.fn(async () => [["stale-token-value-that-is-long-enough"]]);
    const fetchText = vi.fn(async () => { throw new Error("timeout"); });
    await expect(verifySiteOwnership(site, "auto", { resolveTxt, fetchText })).resolves.toEqual({
      ok: false,
      method: "dns_txt",
      reason: "dns_txt_mismatch",
    });
    await expect(verifySiteOwnership(site, "meta_tag", { resolveTxt, fetchText })).resolves.toEqual({
      ok: false,
      method: "meta_tag",
      reason: "meta_tag_unavailable",
    });
  });

  it("refuses to check with an invalid stored token", async () => {
    await expect(verifySiteOwnership({ ...site, verificationToken: "bad" }, "auto", {
      resolveTxt: vi.fn(),
      fetchText: vi.fn(),
    })).resolves.toEqual({ ok: false, method: null, reason: "token_invalid" });
  });
});
