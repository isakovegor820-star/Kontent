import { describe, expect, it, vi } from "vitest";

import { consentEvidenceCsv, findConsentEvidence, summarizeConsentState, type ConsentEvidenceRow } from "./consent-evidence";

function row(overrides: Partial<ConsentEvidenceRow> = {}): ConsentEvidenceRow {
  return {
    id: 1,
    userId: 7,
    contact: null,
    kind: "pd_processing",
    granted: true,
    grantedAt: "2026-10-02T18:00:00.000Z",
    source: "register",
    policyVersion: "2026-08-24",
    consentTextVersion: "draft-2026-10",
    hasIp: true,
    hasUserAgent: true,
    ...overrides,
  };
}

describe("consent evidence", () => {
  it("summarizes the newest record per kind", () => {
    const state = summarizeConsentState([
      row({ id: 3, granted: false, grantedAt: "2026-10-02T20:00:00.000Z", source: "cabinet" }),
      row({ id: 2, granted: true, grantedAt: "2026-10-02T19:00:00.000Z" }),
      row({ id: 1, kind: "marketing", granted: true, grantedAt: "2026-10-01T10:00:00.000Z" }),
    ]);

    expect(state).toEqual([
      expect.objectContaining({ kind: "pd_processing", granted: false, changedAt: "2026-10-02T20:00:00.000Z" }),
      expect.objectContaining({ kind: "marketing", granted: true }),
    ]);
  });

  it("writes a CSV a spreadsheet can open", () => {
    const csv = consentEvidenceCsv([
      row({ contact: 'user@example.test', source: 'форма "заявки", лендинг' }),
      row({ id: 2, userId: null, contact: null, kind: "marketing", granted: false, hasIp: false, hasUserAgent: false }),
    ]);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.split("\r\n")[0]).toContain("granted_at");
    // Кавычки внутри поля удваиваются, поле оборачивается в кавычки — RFC 4180.
    expect(csv).toContain('"форма ""заявки"", лендинг"');
    expect(csv).toContain("false");
    expect(csv).toContain("no");
  });

  it("does not print the address or the client agent, only that they exist", () => {
    const csv = consentEvidenceCsv([row()]);
    expect(csv).toContain("ip_recorded");
    expect(csv).not.toContain("127.0.0.1");
    expect(csv).not.toContain("Mozilla");
  });

  it("normalizes the contact so a capital letter in an email does not hide a person", async () => {
    const query = vi.fn(async (sql: string) => {
      if (String(sql).includes("from users")) return { rows: [] };
      if (String(sql).includes("from leads")) return { rows: [] };
      return { rows: [] };
    });
    await findConsentEvidence({ query } as never, { contact: "  User@Example.Test " });

    // Нормализацию проверяем на запросе к журналу: у запроса заявки контакт
    // стоит первым параметром, у журнала — вторым.
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    const consentsCall = calls.find(([sql]) => String(sql).includes("from consents"));
    expect(consentsCall?.[1]).toEqual([null, "user@example.test"]);
  });

  it("returns nothing without a query instead of dumping every consent", async () => {
    const query = vi.fn();
    await expect(findConsentEvidence({ query } as never, {})).resolves.toEqual({
      account: null,
      rows: [],
      leadContact: null,
      lead: null,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("marks an anonymized account as deleted, not active", async () => {
    const query = vi.fn(async (sql: string) => {
      if (String(sql).includes("from users")) {
        return { rows: [{ id: 9, email: "deleted-user-9@deleted.invalid", name: null, blocked_at: null }] };
      }
      if (String(sql).includes("from leads")) return { rows: [] };
      return { rows: [] };
    });

    const evidence = await findConsentEvidence({ query } as never, { userId: 9 });
    // Поддержка не должна обещать восстановление удалённого аккаунта.
    expect(evidence.account?.status).toBe("deleted");
  });

  it("shows the lead that proves a person used a form", async () => {
    const query = vi.fn(async (sql: string) => {
      if (String(sql).includes("from users")) return { rows: [] };
      if (String(sql).includes("from leads")) {
        return { rows: [{ id: 5, contact: "lead@example.test", source: "landing", created_at: new Date("2026-10-01T10:00:00Z") }] };
      }
      return { rows: [row({ userId: null, contact: "lead@example.test" })] };
    });

    const evidence = await findConsentEvidence({ query } as never, { contact: "lead@example.test" });
    expect(evidence.account).toBeNull();
    expect(evidence.lead).toMatchObject({ id: 5, contact: "lead@example.test", source: "landing" });
    expect(evidence.rows[0]).toMatchObject({ contact: "lead@example.test", granted: true });
  });
});
