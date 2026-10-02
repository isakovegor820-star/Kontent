import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import pg from "pg";

import { migrate } from "../../scripts/migrate.mjs";
import { findPurgeBlockers, findTransferCandidates, purgeAccount } from "@/lib/personal-data";

/**
 * Интеграционная проверка удаления аккаунта на настоящей схеме.
 *
 * Зачем: юнит-тесты подменяют базу и маршрутизируют запросы по подстроке,
 * поэтому противоречие в SQL-предикатах они не видят. Так и случилось: первая
 * версия отбирала блокером проект «без других участников», а кандидатом —
 * «другого участника». Множества не пересекались, передача не срабатывала
 * никогда, и удаление аккаунта единственного владельца было тупиком, а тесты
 * были зелёными, потому что фикстуры давали невозможную комбинацию.
 *
 * Здесь запросы исполняются по-настоящему, и проверяются инварианты:
 *  - блокер и кандидат совместимы (передача возможна);
 *  - проект без других участников удаляется, а не запирает владельца;
 *  - членство уходящего отзывается: призрачного владельца не остаётся;
 *  - командный проект с другими участниками не удаляется.
 */

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
  || target.pathname.slice(1) !== "aurora_migration_test") {
  throw new Error("Account deletion integration requires disposable local aurora_migration_test database");
}

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 8 });

beforeAll(async () => {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
});

afterAll(async () => pool.end());

async function createUser(email: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `insert into users (email, name) values ($1, $2) returning id`,
    [email, email.split("@")[0]],
  );
  return Number(result.rows[0].id);
}

async function createTeamProject(name: string, ownerId: number): Promise<number> {
  const project = await pool.query<{ id: number }>(
    `insert into projects (name, created_by_user_id) values ($1, $2) returning id`,
    [name, ownerId],
  );
  const projectId = Number(project.rows[0].id);
  await pool.query(
    `insert into project_members (project_id, user_id, role, status) values ($1, $2, 'owner', 'active')`,
    [projectId, ownerId],
  );
  return projectId;
}

async function addMember(projectId: number, userId: number, role = "author") {
  await pool.query(
    `insert into project_members (project_id, user_id, role, status) values ($1, $2, $3, 'active')`,
    [projectId, userId, role],
  );
}

describe("account deletion on a real schema", () => {
  it("treats a project with another member as transferable and offers that member", async () => {
    const owner = await createUser(`owner-${Date.now()}@example.test`);
    const colleague = await createUser(`colleague-${Date.now()}@example.test`);
    const projectId = await createTeamProject("Командный", owner);
    await addMember(projectId, colleague);

    const blockers = await findPurgeBlockers(pool, owner);
    const blocker = blockers.find((item) => item.id === projectId);
    // Совместимость множеств: блокер обязан иметь кандидата, иначе передача
    // неисполнима и владелец заперт.
    expect(blocker).toMatchObject({ id: projectId, hasOtherMembers: true });

    const candidates = await findTransferCandidates(pool, projectId, owner);
    expect(candidates.map((item) => item.userId)).toContain(colleague);
    // Сам уходящий кандидатом быть не может.
    expect(candidates.map((item) => item.userId)).not.toContain(owner);

    await pool.query("delete from project_members where project_id = $1", [projectId]);
    await pool.query("delete from projects where id = $1", [projectId]);
    await pool.query("delete from users where id = any($1::bigint[])", [[owner, colleague]]);
  });

  it("deletes a project that has no other members instead of trapping the owner", async () => {
    const owner = await createUser(`solo-${Date.now()}@example.test`);
    const projectId = await createTeamProject("Одинокий", owner);

    const blockers = await findPurgeBlockers(pool, owner);
    expect(blockers.find((item) => item.id === projectId)).toMatchObject({ hasOtherMembers: false });

    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await purgeAccount(client, owner);
      expect(result).toMatchObject({ ok: true, deletedSharedProjects: [projectId] });
      await client.query("commit");
    } finally {
      client.release();
    }

    const project = await pool.query("select 1 from projects where id = $1", [projectId]);
    expect(project.rowCount).toBe(0);
    const user = await pool.query<{ email: string; password_hash: string | null }>(
      "select email, password_hash from users where id = $1",
      [owner],
    );
    expect(user.rows[0].email).toBe(`deleted-user-${owner}@deleted.invalid`);
    expect(user.rows[0].password_hash).toBeNull();
    await pool.query("delete from users where id = $1", [owner]);
  });

  it("revokes the leaving membership so no ghost owner stays in the project", async () => {
    const owner = await createUser(`leaver-${Date.now()}@example.test`);
    const colleague = await createUser(`stayer-${Date.now()}@example.test`);
    const projectId = await createTeamProject("Общий", owner);
    await addMember(projectId, colleague);

    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await purgeAccount(client, owner, { transferSharedTo: colleague });
      expect(result).toMatchObject({ ok: true, transferredSharedProjects: [projectId] });
      await client.query("commit");
    } finally {
      client.release();
    }

    const members = await pool.query<{ user_id: number; role: string; status: string }>(
      `select user_id, role, status from project_members where project_id = $1 order by user_id`,
      [projectId],
    );
    // Ушедший — отозван, коллега — владелец. Призрачного active-owner нет.
    expect(members.rows.find((row) => Number(row.user_id) === owner)).toMatchObject({ status: "revoked" });
    expect(members.rows.find((row) => Number(row.user_id) === colleague)).toMatchObject({
      role: "owner",
      status: "active",
    });
    // Командный проект с другим участником не удаляется.
    const project = await pool.query("select 1 from projects where id = $1", [projectId]);
    expect(project.rowCount).toBe(1);

    await pool.query("delete from project_members where project_id = $1", [projectId]);
    await pool.query("delete from projects where id = $1", [projectId]);
    await pool.query("delete from users where id = any($1::bigint[])", [[owner, colleague]]);
  });

  it("refuses a successor who is not a member of the project", async () => {
    const ownerEmail = `purist-${Date.now()}@example.test`;
    const owner = await createUser(ownerEmail);
    const stranger = await createUser(`stranger-${Date.now()}@example.test`);
    const colleague = await createUser(`mate-${Date.now()}@example.test`);
    const projectId = await createTeamProject("Закрытый", owner);
    await addMember(projectId, colleague);

    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await purgeAccount(client, owner, { transferSharedTo: stranger });
      expect(result).toMatchObject({ ok: false, error: "invalid_transfer_target" });
      await client.query("rollback");
    } finally {
      client.release();
    }

    // Пользователь невредим: обезличивание не выполнено, почта на месте.
    const user = await pool.query<{ email: string }>("select email from users where id = $1", [owner]);
    expect(user.rows[0].email).toBe(ownerEmail);
    expect(user.rows[0].email).not.toContain("deleted.invalid");

    await pool.query("delete from project_members where project_id = $1", [projectId]);
    await pool.query("delete from projects where id = $1", [projectId]);
    await pool.query("delete from users where id = any($1::bigint[])", [[owner, stranger, colleague]]);
  });

  it("keeps another user's preferences alive when their selected project is deleted", async () => {
    // Ветка user_project_preferences раньше не была покрыта ничем, а она на
    // основном пути: у каждого пользователя есть строка настроек, и она обычно
    // указывает на его личный проект, который удаляется первым. Если бы ссылку
    // просто удаляли, человек терял бы вместе с ней и остальные настройки.
    const owner = await createUser(`pref-owner-${Date.now()}@example.test`);
    const colleague = await createUser(`pref-mate-${Date.now()}@example.test`);
    // Осиротевший командный проект владельца: участников нет, поэтому он
    // удаляется вместе с аккаунтом — именно этот случай и нужен.
    const doomedProject = await createTeamProject("Осиротевший", owner);
    // У коллеги есть собственный личный проект — на него и должен перейти выбор.
    const fallback = await pool.query<{ id: number }>(
      `insert into projects (name, created_by_user_id, personal_owner_user_id)
       values ('Личный коллеги', $1, $1) returning id`,
      [colleague],
    );
    const fallbackId = Number(fallback.rows[0].id);
    await pool.query(
      `insert into user_project_preferences (user_id, selected_project_id) values ($1, $2)
       on conflict (user_id) do update set selected_project_id = excluded.selected_project_id`,
      [colleague, doomedProject],
    );

    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await purgeAccount(client, owner);
      expect(result).toMatchObject({ ok: true, deletedSharedProjects: [doomedProject] });
      await client.query("commit");
    } finally {
      client.release();
    }

    // Строка настроек коллеги жива и переведена на доступный ему проект.
    const preferences = await pool.query<{ selected_project_id: number }>(
      `select selected_project_id from user_project_preferences where user_id = $1`,
      [colleague],
    );
    expect(preferences.rowCount).toBe(1);
    expect(Number(preferences.rows[0].selected_project_id)).toBe(fallbackId);

    await pool.query("delete from user_project_preferences where user_id = $1", [colleague]);
    await pool.query("delete from projects where id = $1", [fallbackId]);
    await pool.query("delete from users where id = any($1::bigint[])", [[owner, colleague]]);
  });

  it("leaves the project with the co-owner when one owner deletes the account", async () => {
    const first = await createUser(`co1-${Date.now()}@example.test`);
    const second = await createUser(`co2-${Date.now()}@example.test`);
    const projectId = await createTeamProject("Два владельца", first);
    await addMember(projectId, second, "owner");

    // У первого владельца есть со-владелец, поэтому блокера нет: проект
    // остаётся второму, и удаление проходит без передачи.
    const blockers = await findPurgeBlockers(pool, first);
    expect(blockers.find((item) => item.id === projectId)).toBeUndefined();

    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await purgeAccount(client, first);
      expect(result).toMatchObject({ ok: true, deletedSharedProjects: [] });
      await client.query("commit");
    } finally {
      client.release();
    }

    const project = await pool.query("select 1 from projects where id = $1", [projectId]);
    expect(project.rowCount).toBe(1);
    const members = await pool.query<{ user_id: number; role: string; status: string }>(
      `select user_id, role, status from project_members where project_id = $1`,
      [projectId],
    );
    // Второй владелец действует, ушедший отозван: проект управляем.
    expect(members.rows.find((row) => Number(row.user_id) === second)).toMatchObject({ role: "owner", status: "active" });
    expect(members.rows.find((row) => Number(row.user_id) === first)).toMatchObject({ status: "revoked" });

    await pool.query("delete from project_members where project_id = $1", [projectId]);
    await pool.query("delete from projects where id = $1", [projectId]);
    await pool.query("delete from projects where personal_owner_user_id = $1", [second]);
    await pool.query("delete from users where id = any($1::bigint[])", [[first, second]]);
  });

  it("requires one successor who fits every project that needs one", async () => {
    const owner = await createUser(`multi-${Date.now()}@example.test`);
    const common = await createUser(`multi-common-${Date.now()}@example.test`);
    const onlyFirst = await createUser(`multi-first-${Date.now()}@example.test`);
    const first = await createTeamProject("Первый", owner);
    const second = await createTeamProject("Второй", owner);
    await addMember(first, common);
    await addMember(first, onlyFirst);
    await addMember(second, common);

    const candidatesForFirst = await findTransferCandidates(pool, first, owner);
    const candidatesForSecond = await findTransferCandidates(pool, second, owner);
    // Общий кандидат есть, «только первый» не подходит второму проекту.
    expect(candidatesForFirst.map((item) => item.userId)).toEqual(expect.arrayContaining([common, onlyFirst]));
    expect(candidatesForSecond.map((item) => item.userId)).toEqual([common]);

    const client = await pool.connect();
    try {
      await client.query("begin");
      // Участник, подходящий лишь одному проекту, отклоняется.
      const rejected = await purgeAccount(client, owner, { transferSharedTo: onlyFirst });
      expect(rejected).toMatchObject({ ok: false, error: "invalid_transfer_target" });
      await client.query("rollback");
    } finally {
      client.release();
    }

    const client2 = await pool.connect();
    try {
      await client2.query("begin");
      const accepted = await purgeAccount(client2, owner, { transferSharedTo: common });
      expect(accepted).toMatchObject({ ok: true, transferredSharedProjects: [first, second] });
      await client2.query("commit");
    } finally {
      client2.release();
    }

    const owners = await pool.query<{ project_id: number; user_id: number; role: string }>(
      `select project_id, user_id, role from project_members
        where project_id = any($1::bigint[]) and status = 'active' and role = 'owner'`,
      [[first, second]],
    );
    expect(owners.rows.map((row) => Number(row.user_id))).toEqual([common, common]);

    for (const projectId of [first, second]) {
      await pool.query("delete from project_members where project_id = $1", [projectId]);
      await pool.query("delete from projects where id = $1", [projectId]);
    }
    await pool.query("delete from user_project_preferences where user_id = any($1::bigint[])", [[common, onlyFirst]]);
    await pool.query("delete from projects where personal_owner_user_id = any($1::bigint[])", [[common, onlyFirst]]);
    await pool.query("delete from users where id = any($1::bigint[])", [[owner, common, onlyFirst]]);
  });
});
