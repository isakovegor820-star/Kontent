import { describe, expect, it, vi } from "vitest";

import { listConsentHistory, listUserConsents, revokeConsent, toConsentState } from "./consent-lifecycle";

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kind: "pd_processing",
    granted: true,
    granted_at: new Date("2026-10-02T18:00:00.000Z"),
    consent_text_version: "draft-2026-10",
    policy_version: "2026-08-24",
    source: "register",
    ...overrides,
  };
}

describe("consent lifecycle", () => {
  it("turns a journal row into a state, not a boolean", () => {
    const state = toConsentState(row());
    expect(state).toEqual({
      kind: "pd_processing",
      granted: true,
      changedAt: "2026-10-02T18:00:00.000Z",
      consentTextVersion: "draft-2026-10",
      policyVersion: "2026-08-24",
      source: "register",
    });
  });

  it("returns every known kind, including the ones without consent", async () => {
    // Запрос уже отдаёт последнюю запись по виду (distinct on kind).
    const query = vi.fn().mockResolvedValue({ rows: [row()] });
    const states = await listUserConsents({ query }, 42);

    expect(states.map((state) => state.kind)).toEqual([
      "pd_processing",
      "marketing",
      "pd_distribution",
      "cookie",
    ]);
    // Виды без записей показываются как «согласия нет» — интерфейс обязан
    // показать не только данное согласие, но и его отсутствие.
    expect(states[1]).toMatchObject({ kind: "marketing", granted: false, changedAt: "" });
    expect(query.mock.calls[0][0]).toContain("distinct on (kind)");
  });

  it("reads history newest first and hides the raw address", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        row({ granted: false, ip: "203.0.113.7", user_agent: "vitest" }),
        row({ ip: null, user_agent: null }),
      ],
    });
    const history = await listConsentHistory({ query }, 42);

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ granted: false, hasIp: true, hasUserAgent: true });
    expect(history[1]).toMatchObject({ hasIp: false, hasUserAgent: false });
    // Сам адрес в выгрузку не попадает: он доказательство для оператора, не для показа.
    expect(JSON.stringify(history)).not.toContain("203.0.113.7");
    expect(query.mock.calls[0][0]).toContain("order by granted_at desc");
  });

  it("revokes an active consent with a new journal row", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row()] }) // чтение действующего согласия
      .mockResolvedValueOnce({ rowCount: 1 }); // вставка отзыва
    const result = await revokeConsent({ query }, { userId: 42, kind: "pd_processing" });

    expect(result).toEqual({ ok: true, revoked: true });
    const [insertSql, insertValues] = query.mock.calls[1] as [string, unknown[]];
    expect(insertSql).toContain("insert into consents");
    expect(insertValues).toContain(false);
    expect(insertValues).toContain("cabinet");
  });

  it("does not write a second revocation for the same consent", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [row({ granted: false })] });
    const result = await revokeConsent({ query }, { userId: 42, kind: "pd_processing" });

    expect(result).toEqual({ ok: false, error: "not_granted" });
    // Иначе журнал заполнится одинаковыми отзывами и по нему нельзя будет
    // понять, когда человек отозвал согласие на самом деле.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("treats a missing consent as nothing to revoke", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    await expect(revokeConsent({ query }, { userId: 42, kind: "marketing" })).resolves.toEqual({
      ok: false,
      error: "not_granted",
    });
  });
});
