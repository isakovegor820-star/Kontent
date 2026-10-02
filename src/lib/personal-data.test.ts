import { describe, expect, it, vi } from "vitest";

import {
  DATA_EXPORT_EXCLUDED,
  collectUserData,
  findPurgeBlockers,
  findTransferCandidates,
  purgeAccount,
  recordDataRequest,
} from "./personal-data";

/** Мок клиента БД: маршрутизирует запросы по подстроке, как это делал бы pool. */
function client(routes: Array<{ match: string; rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn(async (sql: string) => {
    const route = routes.find((item) => String(sql).includes(item.match));
    return { rows: route?.rows ?? [], rowCount: route?.rowCount ?? 0 };
  });
  return { client: { query }, query };
}

describe("personal data export", () => {
  it("collects the subject data and never the operator secrets", async () => {
    const { client: query, query: queryMock } = client([
      { match: "from users where id", rows: [{ id: 7, email: "user@example.test", name: "Иван", created_at: new Date("2026-01-01T00:00:00Z"), onboarding_completed_at: null, has_password: true }] },
      { match: "from consents", rows: [{ kind: "pd_processing", granted: true, granted_at: new Date("2026-10-02T18:00:00Z"), source: "register", policy_version: "2026-08-24", consent_text_version: "draft-2026-10" }] },
      { match: "from projects p", rows: [{ id: 1, name: "Личный проект", role: null, personal: true, joined_at: null }] },
      { match: "from channels", rows: [{ id: 3, title: "Канал", network: "tg", created_at: new Date("2026-02-02T00:00:00Z") }] },
      { match: "from posts", rows: [{ id: 11, channel_id: 3, status: "published", created_at: new Date("2026-03-03T00:00:00Z") }] },
      { match: "from drafts", rows: [{ id: 12, project_id: 1, excerpt: "Начало текста", created_at: new Date("2026-03-04T00:00:00Z") }] },
      { match: "from sessions", rows: [{ active: 2 }] },
    ]);

    const data = await collectUserData(query as never, 7);

    expect(data.account).toMatchObject({ id: 7, email: "user@example.test", hasPassword: true });
    expect(data.consents).toHaveLength(1);
    expect(data.projects[0]).toMatchObject({ personal: true });
    expect(data.channels[0]).toMatchObject({ createdAt: "2026-02-02T00:00:00.000Z" });
    expect(data.drafts[0]).toMatchObject({ excerpt: "Начало текста" });
    expect(data.sessions.active).toBe(2);
    // Хеш пароля и токены в выгрузку не попадают — это перечислено явно,
    // чтобы интерфейс мог показать границу.
    expect(DATA_EXPORT_EXCLUDED.join(" ")).toContain("хеш пароля");
    const statements = queryMock.mock.calls.map(([sql]: [string]) => String(sql)).join("\n");
    expect(statements).not.toContain("password_hash,");
    expect(statements).not.toContain("oauth_tokens");
  });

  it("fails loudly when the account is gone", async () => {
    const { client: query } = client([{ match: "from users where id", rows: [] }]);
    await expect(collectUserData(query as never, 404)).rejects.toThrow("user_not_found");
  });
});

describe("account deletion", () => {
  it("lists shared projects that would be left without an owner", async () => {
    const { client: query } = client([
      { match: "from projects p", rows: [{ id: 5, name: "Командный", has_other_members: true }] },
    ]);
    await expect(findPurgeBlockers(query as never, 7)).resolves.toEqual([
      { id: 5, name: "Командный", hasOtherMembers: true },
    ]);
  });

  it("refuses to delete while a shared project has someone to hand it to", async () => {
    const { client: query, query: queryMock } = client([
      { match: "from projects p", rows: [{ id: 5, name: "Командный", has_other_members: true }] },
    ]);
    const result = await purgeAccount(query as never, 7);
    expect(result).toEqual({
      ok: false,
      error: "shared_project_owner",
      projects: [{ id: 5, name: "Командный", hasOtherMembers: true }],
    });
    // Никаких изменений до устранения причины.
    const statements = queryMock.mock.calls.map(([sql]: [string]) => String(sql)).join("\n");
    expect(statements).not.toContain("update users");
  });

  it("erases personal data, ends sessions and revokes consent", async () => {
    const { client: query, query: queryMock } = client([
      { match: "from projects p", rows: [] },
      // Личный проект: сначала выбираем его id, затем удаляем слоями.
      { match: "select id from projects", rows: [{ id: 1 }] },
      { match: "update users", rowCount: 1 },
      { match: "delete from sessions", rowCount: 2 },
      { match: "update consents", rowCount: 1 },
    ]);

    const result = await purgeAccount(query as never, 7);

    expect(result).toMatchObject({ ok: true, deletedPersonalProjects: 1 });
    const statements = queryMock.mock.calls.map(([sql]: [string]) => String(sql));
    const update = statements.find((sql) => sql.includes("update users")) ?? "";
    // Стираем именно персональные данные, а не всю строку: на users ссылаются
    // десятки таблиц с запретом удаления, и каскад унёс бы чужие данные.
    for (const field of ["email", "name", "avatar", "password_hash", "tg_id", "vk_id"]) {
      expect(update).toContain(field);
    }
    expect(statements.some((sql) => sql.includes("delete from sessions"))).toBe(true);
    expect(statements.some((sql) => sql.includes("update consents set granted = false"))).toBe(true);
  });

  it("transfers a shared project when the owner chooses the successor", async () => {
    const { client: query, query: queryMock } = client([
      { match: "from projects p", rows: [{ id: 5, name: "Командный", has_other_members: true }] },
      // Цель передачи — действующий участник проекта.
      { match: "from project_members member", rows: [{ user_id: 9, name: "Коллега", role: "author" }] },
      { match: "select id from projects", rows: [] },
      { match: "update project_members", rowCount: 1 },
      { match: "update users", rowCount: 1 },
      { match: "delete from sessions", rowCount: 0 },
      { match: "update consents", rowCount: 0 },
    ]);

    const result = await purgeAccount(query as never, 7, { transferSharedTo: 9 });
    expect(result).toMatchObject({ ok: true, transferredSharedProjects: [5] });
    const calls = queryMock.mock.calls as unknown as Array<[string, unknown[]?]>;
    const transfer = calls.find(([sql]) => String(sql).includes("update project_members"));
    expect(String(transfer?.[0])).toContain("role = 'owner'");
    expect(transfer?.[1]).toEqual([5, 9]);
  });

  it("records the request so the deadline and outcome are verifiable", async () => {
    const { client: query, query: queryMock } = client([{ match: "insert into data_requests", rowCount: 1 }]);
    await recordDataRequest(query as never, { userId: 7, kind: "deletion", state: "completed", result: { ok: true } });

    const [sql, values] = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("insert into data_requests");
    expect(values[1]).toBe("deletion");
    expect(values[2]).toBe("completed");
  });

  it("refuses a transfer target who is not an active member of the project", async () => {
    const { client: query, query: queryMock } = client([
      { match: "from projects p", rows: [{ id: 5, name: "Командный", has_other_members: true }] },
      // Кандидат один — 9, а просят передать 99.
      { match: "from project_members member", rows: [{ user_id: 9, name: "Коллега", role: "author" }] },
      { match: "select id from projects", rows: [{ id: 1 }] },
    ]);

    const result = await purgeAccount(query as never, 7, { transferSharedTo: 99 });

    expect(result).toEqual({
      ok: false,
      error: "invalid_transfer_target",
      projects: [{ id: 5, name: "Командный", hasOtherMembers: true }],
    });
    // Ничего не удалено и не изменено: проверка стоит до удаления личных проектов.
    const statements = (queryMock.mock.calls as unknown as Array<[string]>).map(([sql]) => String(sql)).join("\n");
    expect(statements).not.toContain("update users");
    expect(statements).not.toContain("delete from sessions");
    expect(statements).not.toContain("delete from projects");
  });

  it("does not allow handing a project to the leaving owner", async () => {
    const { client: dbClient } = client([
      { match: "from projects p", rows: [{ id: 5, name: "Командный", has_other_members: true }] },
      // Запрос кандидатов исключает самого уходящего (member.user_id <> $2),
      // поэтому попытка передать себе не находит цель.
      { match: "from project_members member", rows: [] },
    ]);

    const result = await purgeAccount(dbClient as never, 7, { transferSharedTo: 7 });
    expect(result).toMatchObject({ ok: false, error: "invalid_transfer_target" });
  });

  it("lists candidates by role, excluding the leaving owner", async () => {
    const queryMock = vi.fn(async () => ({
      rows: [
        { user_id: 11, name: "Публикатор", role: "publisher" },
        { user_id: 9, name: "Автор", role: "author" },
      ],
    }));
    const candidates = await findTransferCandidates({ query: queryMock } as never, 5, 7);

    expect(candidates).toEqual([
      { userId: 11, name: "Публикатор", role: "publisher" },
      { userId: 9, name: "Автор", role: "author" },
    ]);
    expect((queryMock.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual([5, 7]);
  });

  it("deletes a shared project that has no other members instead of trapping the owner", async () => {
    // Единственный участник проекта: передать некому, поэтому проект уходит
    // вместе с аккаунтом. Иначе человек не мог бы воспользоваться правом на
    // удаление — это и был тупик первой версии.
    const { client: query, query: queryMock } = client([
      { match: "from projects p", rows: [{ id: 5, name: "Командный", has_other_members: false }] },
      { match: "select id from projects", rows: [{ id: 1 }] },
      { match: "update users", rowCount: 1 },
      { match: "delete from sessions", rowCount: 0 },
      { match: "update consents", rowCount: 0 },
    ]);

    const result = await purgeAccount(query as never, 7);

    expect(result).toMatchObject({ ok: true, deletedSharedProjects: [5], transferredSharedProjects: [] });
    const statements = (queryMock.mock.calls as unknown as Array<[string]>).map(([sql]) => String(sql)).join("\n");
    expect(statements).not.toContain("update project_members set role");
  });

  it("revokes the leaving membership so no ghost owner remains", async () => {
    const { client: query, query: queryMock } = client([
      { match: "from projects p", rows: [] },
      { match: "select id from projects", rows: [] },
      { match: "update users", rowCount: 1 },
      { match: "delete from sessions", rowCount: 0 },
      { match: "update consents", rowCount: 0 },
    ]);

    await purgeAccount(query as never, 7);

    // Без отзыва членства проект остаётся с обезличенным «владельцем»: войти
    // нельзя, а members.manage есть только у владельца — проект неуправляем.
    const statements = (queryMock.mock.calls as unknown as Array<[string]>).map(([sql]) => String(sql));
    const revoke = statements.find((sql) => sql.includes("set status = 'revoked'"));
    expect(revoke).toBeTruthy();
    expect(revoke).toContain("where user_id = $1 and status = 'active'");
  });

  it("refuses when the successor was revoked between validation and update", async () => {
    const { client: query } = client([
      { match: "from projects p", rows: [{ id: 5, name: "Командный", has_other_members: true }] },
      { match: "from project_members member", rows: [{ user_id: 9, name: "Коллега", role: "author" }] },
      { match: "select id from projects", rows: [{ id: 1 }] },
      // UPDATE не затронул ни одной строки: участника отозвали.
      { match: "update project_members set role", rowCount: 0 },
    ]);

    const result = await purgeAccount(query as never, 7, { transferSharedTo: 9 });
    expect(result).toMatchObject({ ok: false, error: "invalid_transfer_target" });
  });
});
