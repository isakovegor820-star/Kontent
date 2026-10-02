import { describe, expect, it, vi } from "vitest";

import { loadAdminUserDetail } from "./admin-users";

/**
 * Контракт карточки аккаунта в админке: поддержка и юрист должны видеть
 * согласия субъекта. Отдельный тест на форму ответа — потому что доказывать
 * получение согласия обязан оператор (ч. 3 ст. 9 152-ФЗ), и «поля нет»
 * означает, что доказательства в интерфейсе нет вообще.
 */
describe("admin user detail carries consent evidence", () => {
  function fakeDb(consentRows: unknown[]) {
    const identity = {
      id: 7,
      name: "Иван",
      email: "user@example.test",
      created_at: new Date("2026-01-01T00:00:00Z"),
      onboarding_completed_at: null,
      bot_linked: false,
      ai_engine: null,
      email_login: true,
      password_login: true,
      telegram_login: false,
      vk_login: false,
      last_activity_at: new Date("2026-10-02T18:00:00Z"),
      blocked_at: null,
      blocked_reason: null,
      ai_daily_limit: null,
    };
    const query = vi.fn(async (sql: string) => {
      const text = String(sql);
      if (text.includes("from users app_user")) return { rows: [identity], rowCount: 1 };
      if (text.includes("from consents")) return { rows: consentRows, rowCount: consentRows.length };
      if (text.includes("from leads")) return { rows: [], rowCount: 0 };
      if (text.includes("from users where id") || text.includes("lower(email)")) {
        return { rows: [{ id: 7, email: "user@example.test", name: "Иван", blocked_at: null }], rowCount: 1 };
      }
      // Остальные запросы карточки возвращают пусто: тест про согласия.
      return { rows: [{ count: 0 }], rowCount: 1 };
    });
    return { query } as never;
  }

  it("returns current state, history and the account status", async () => {
    const detail = await loadAdminUserDetail(
      fakeDb([
        {
          id: 2,
          user_id: 7,
          contact: null,
          kind: "pd_processing",
          granted: false,
          granted_at: new Date("2026-10-02T19:00:00Z"),
          source: "cabinet",
          policy_version: "2026-08-24",
          consent_text_version: "draft-2026-10",
          ip: "203.0.113.7",
          user_agent: "vitest",
        },
        {
          id: 1,
          user_id: 7,
          contact: null,
          kind: "pd_processing",
          granted: true,
          granted_at: new Date("2026-10-02T18:00:00Z"),
          source: "register",
          policy_version: "2026-08-24",
          consent_text_version: "draft-2026-10",
          ip: "203.0.113.7",
          user_agent: "vitest",
        },
      ]),
      7,
      30,
    );

    expect(detail?.consents.current).toEqual([
      expect.objectContaining({ kind: "pd_processing", granted: false, source: "cabinet" }),
    ]);
    expect(detail?.consents.history).toHaveLength(2);
    expect(detail?.consents.accountStatus).toBe("active");
    // Адрес и клиентский агент в карточку не отдаём: только факт фиксации.
    expect(JSON.stringify(detail?.consents)).not.toContain("203.0.113.7");
    expect(detail?.consents.history[0]).toMatchObject({ hasIp: true, hasUserAgent: true });
  });

  it("does not pretend there are consents when the journal is empty", async () => {
    const detail = await loadAdminUserDetail(fakeDb([]), 7, 30);
    expect(detail?.consents.current).toEqual([]);
    expect(detail?.consents.history).toEqual([]);
    expect(detail?.consents.lead).toBeNull();
  });
});
