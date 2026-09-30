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

  it("does not grant access by email unless the operator explicitly opted in", () => {
    const env = { AURORA_ADMIN_EMAILS: "Owner@Example.com" } as unknown as NodeJS.ProcessEnv;
    // Без явного флага email-allowlist не даёт доступ: регистрация не подтверждает
    // владение почтой, и адрес мог зарегистрировать кто угодно.
    expect(adminAccessConfigured(env)).toBe(false);
    expect(hasAuroraAdminAccess({ id: 2, email: "owner@example.com" }, env)).toBe(false);
  });

  it("grants by email only with the explicit operator opt-in", () => {
    const env = {
      AURORA_ADMIN_EMAILS: "Owner@Example.com, ops@example.com",
      AURORA_ADMIN_ALLOW_EMAILS: "1",
    } as unknown as NodeJS.ProcessEnv;
    expect(adminAccessConfigured(env)).toBe(true);
    expect(hasAuroraAdminAccess({ id: 2, email: "owner@example.com" }, env)).toBe(true);
    expect(hasAuroraAdminAccess({ id: 3, email: "owner@example.com.evil" }, env)).toBe(false);
  });
});
