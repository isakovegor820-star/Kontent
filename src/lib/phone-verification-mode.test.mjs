import { describe, expect, it } from "vitest";

import { phoneVerificationMode } from "./phone-verification-mode.mjs";

describe("phone verification runtime mode", () => {
  it("allows the temporary code only outside production", () => {
    expect(phoneVerificationMode({ NODE_ENV: "development" })).toBe("temporary");
    expect(phoneVerificationMode({ NODE_ENV: "test" })).toBe("temporary");
  });

  it("cannot be enabled by the legacy flag in production", () => {
    expect(phoneVerificationMode({
      NODE_ENV: "production",
      AURORA_TEMPORARY_PHONE_VERIFICATION: "true",
    })).toBe("unavailable");
  });
});
