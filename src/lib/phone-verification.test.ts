import { describe, expect, it } from "vitest";

import { createPhoneVerificationCode, verifyPhoneCode } from "./phone-verification";

describe("phone verification", () => {
  it("stores a salted hash instead of the six-digit code", () => {
    const challenge = createPhoneVerificationCode();
    expect(challenge.code).toMatch(/^[0-9]{6}$/u);
    expect(challenge.encodedHash).not.toContain(challenge.code);
    expect(verifyPhoneCode(challenge.code, challenge.encodedHash)).toBe(true);
    expect(verifyPhoneCode("000000", challenge.encodedHash)).toBe(challenge.code === "000000");
  });

  it("fails closed on malformed values", () => {
    expect(verifyPhoneCode("12345", "salt:digest")).toBe(false);
    expect(verifyPhoneCode("123456", "broken")).toBe(false);
  });
});
