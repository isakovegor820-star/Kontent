import { describe, expect, it, vi } from "vitest";

import {
  generateSiteVerificationToken,
  htmlContainsVerificationMeta,
  isSiteVerificationToken,
  siteVerificationInstructions,
  siteVerificationRedirectAllowed,
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

  it.each([
    `<head><link title='<meta name="aurora-site-verification" content="${token}">'></head>`,
    `<head><link title='<meta name="aurora-site-verification" content="${token}"></head>`,
    `<body><head><meta name="aurora-site-verification" content="${token}"></head></body>`,
    `<!-- <meta name="aurora-site-verification" content="${token}"> -->`,
    `<html><body><meta name="aurora-site-verification" content="${token}"></body></html>`,
    `<head><script type="application/json">{"example":"<meta name='aurora-site-verification' content='${token}'>"}</script></head>`,
  ])("does not accept non-head/inert user content as domain ownership", (html) => {
    expect(htmlContainsVerificationMeta(html, token)).toBe(false);
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
    expect(htmlContainsVerificationMeta(`<head><meta name="AURORA-SITE-VERIFICATION" content="${token}" /></head>`, token)).toBe(true);
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

  it("rejects cross-domain and HTTPS downgrade verification redirects", () => {
    expect(siteVerificationRedirectAllowed(new URL("https://attacker.example/"), new URL(site.canonicalUrl))).toBe(false);
    expect(siteVerificationRedirectAllowed(new URL("http://example.ru/"), new URL(site.canonicalUrl))).toBe(false);
    expect(siteVerificationRedirectAllowed(new URL("https://example.ru/home"), new URL(site.canonicalUrl))).toBe(true);
  });

  it("refuses to check with an invalid stored token", async () => {
    await expect(verifySiteOwnership({ ...site, verificationToken: "bad" }, "auto", {
      resolveTxt: vi.fn(),
      fetchText: vi.fn(),
    })).resolves.toEqual({ ok: false, method: null, reason: "token_invalid" });
  });
});
