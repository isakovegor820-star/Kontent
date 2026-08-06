import { describe, expect, it } from "vitest";

import {
  assertAvatarIngressConfigured,
  avatarIngressConfigured,
} from "./upload-ingress.mjs";

describe("avatar ingress deployment contract", () => {
  it("does not block local/test processes", () => {
    expect(avatarIngressConfigured({ NODE_ENV: "test" })).toBe(true);
  });

  it("fails production closed without a real hard-limit declaration", () => {
    expect(avatarIngressConfigured({ NODE_ENV: "production" })).toBe(false);
    expect(() => assertAvatarIngressConfigured({ NODE_ENV: "production" }))
      .toThrow("avatar_ingress_limit_not_configured");
  });

  it("accepts only the supported multipart limit range", () => {
    expect(avatarIngressConfigured({
      NODE_ENV: "production",
      AURORA_AVATAR_BODY_LIMIT_BYTES: String(5 * 1024 * 1024 + 256 * 1024),
    })).toBe(true);
    expect(avatarIngressConfigured({
      NODE_ENV: "production",
      AURORA_AVATAR_BODY_LIMIT_BYTES: String(20 * 1024 * 1024),
    })).toBe(false);
  });
});
