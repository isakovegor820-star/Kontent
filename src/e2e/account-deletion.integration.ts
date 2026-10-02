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
});
