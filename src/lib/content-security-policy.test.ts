import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy } from "./content-security-policy";

describe("strict content security policy", () => {
  const nonce = "YXVyb3JhLXN0cmljdC1ub25jZQ==";

  it("allows framework inline code only through the request nonce", () => {
    const policy = buildContentSecurityPolicy(nonce);

    expect(policy).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(policy).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/u);
    expect(policy).not.toMatch(/style-src(?!-attr)[^;]*'unsafe-inline'/u);
    expect(policy).not.toContain("unsafe-eval");
  });

  it("opens eval only for the React development runtime", () => {
    expect(buildContentSecurityPolicy(nonce, true)).toMatch(
      /script-src[^;]*'unsafe-eval'/u,
    );
  });

  it("rejects values that could inject another directive", () => {
    expect(() => buildContentSecurityPolicy("value'; connect-src *"))
      .toThrowError("invalid_csp_nonce");
  });
});
