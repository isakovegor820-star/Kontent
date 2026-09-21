import { describe, expect, it } from "vitest";

import { adminAccessConfigured, hasAuroraAdminAccess } from "./admin-access";

describe("Aurora global admin allowlist", () => {
  it("fails closed when no allowlist is configured", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(adminAccessConfigured(env)).toBe(false);
    expect(hasAuroraAdminAccess({ id: 1, email: "owner@example.com" }, env)).toBe(false);
  });

  it("accepts only positive configured user ids", () => {
    const env = { AURORA_ADMIN_USER_IDS: " 7, bad, -2, 14 " } as unknown as NodeJS.ProcessEnv;
    expect(hasAuroraAdminAccess({ id: 7, email: null }, env)).toBe(true);
    expect(hasAuroraAdminAccess({ id: 14, email: null }, env)).toBe(true);
    expect(hasAuroraAdminAccess({ id: 2, email: null }, env)).toBe(false);
  });

  it("normalizes configured emails without granting a partial match", () => {
    const env = { AURORA_ADMIN_EMAILS: "Owner@Example.com, ops@example.com" } as unknown as NodeJS.ProcessEnv;
    expect(hasAuroraAdminAccess({ id: 2, email: "owner@example.com" }, env)).toBe(true);
    expect(hasAuroraAdminAccess({ id: 3, email: "owner@example.com.evil" }, env)).toBe(false);
  });
});
