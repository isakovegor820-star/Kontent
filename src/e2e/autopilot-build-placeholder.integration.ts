import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  committedAutopilotResultExistsSql,
  finalizeAutopilotBuildPlaceholder,
  supersedeAutopilotAttempts,
} from "@/lib/autopilot-build-finalize.mjs";
import { reconcileBuildingAutopilotPlans } from "@/lib/autopilot-weekly-queue.mjs";

// Сборка живёт в двух строках: плейсхолдер `building`, который опрашивает страница, и строка
// готового плана. Этот тест фиксирует жизненный цикл на настоящем PostgreSQL: незакрытый
// плейсхолдер превращал завершённую сборку в бесконечную загрузку и в вечный повтор
// генерации каждые 30 секунд — reconciler считал её незавершённой работой.
const target = new URL(String(process.env.DATABASE_URL));
if (target.hostname !== "127.0.0.1" || !["55437", "5432"].includes(target.port)) {
  throw new Error("Isolated local PostgreSQL required");
}
const admin = new pg.Pool({ connectionString: target.href });
const database = `aurora_autopilot_placeholder_${randomUUID().replaceAll("-", "")}`;
target.pathname = `/${database}`;
const pool = new pg.Pool({ connectionString: target.href, max: 8, application_name: "autopilot-placeholder-test" });

let actor: number;
let project: number;
let channel: number;

const readyItems = [0, 1, 2, 3, 4].map((index) => ({
  i: index,
  topic: `Тема ${index + 1}`,
  draft: `Готовый текст ${index + 1}`,
  scheduledAt: new Date(Date.now() + (index + 1) * 86_400_000).toISOString(),
  status: "pending",
  aiReady: true,
  quality: { passed: true, score: 92, threshold: 80, blockers: [], violations: [] },
}));

async function insertPlan(client: pg.Pool | pg.PoolClient, status: string, report: Record<string, unknown> = { requestedBy: "human" }) {
  const inserted = await client.query(
    `insert into autopilot_plan
       (project_id, user_id, channel_id, week_start, status, expected_post_count,
        publication_target_count, candidate_count, items, build_report)
     values ($1, $2, $3, current_date, $4, 5, 5, 6, $5::jsonb, $6::jsonb)
     returning id`,
    [project, actor, channel, status, JSON.stringify(readyItems), JSON.stringify(report)],
  );
  return Number(inserted.rows[0].id);
}

const statusOf = async (planId: number) =>
  (await pool.query(
    `select status, terminal_outcome, build_report from autopilot_plan where id = $1`,
    [planId],
  )).rows[0];

beforeAll(async () => {
  await admin.query(`create database ${database}`);
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await pool.query("truncate autopilot_plan, autopilot_settings, channels, project_members, projects, users restart identity cascade");
  actor = Number((await pool.query(
    "insert into users(email) values($1) returning id",
    [`autopilot-${randomUUID()}@example.test`],
  )).rows[0].id);
  project = Number((await pool.query(
    "insert into projects(name, created_by_user_id) values('Autopilot build', $1) returning id",
    [actor],
  )).rows[0].id);
  await pool.query(
    "insert into project_members(project_id, user_id, role, status) values($1, $2, 'owner', 'active')",
    [project, actor],
  );
  channel = Number((await pool.query(
    `insert into channels(user_id, project_id, network, title, tg_chat_id, is_active)
     values($1, $2, 'tg', 'Autopilot channel', $3, true) returning id`,
    [actor, project, -1007000000 - actor],
  )).rows[0].id);
  await pool.query(
    `insert into autopilot_settings(user_id, project_id, channel_id, enabled, post_frequency)
     values($1, $2, $3, true, 5)`,
    [actor, project, channel],
  );
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe.sequential("Autopilot build placeholder lifecycle", () => {
  // Состояние, которое оставлял успешный прогон: план записан, плейсхолдер ещё `building`.
  // Пока его переотправляли, Аврора собирала ту же неделю заново каждые 30 секунд, а страница
  // бесконечно показывала «Готово 5 из 5» с крутящимся индикатором.
  it("closes a placeholder whose result is already committed instead of rebuilding it", async () => {
    const placeholder = await insertPlan(pool, "building");
    const committed = await insertPlan(pool, "pending", { selectedCount: 5 });
    const queue = { add: vi.fn(async () => ({})) };

    await expect(reconcileBuildingAutopilotPlans({ pool, queue })).resolves.toEqual({
      scanned: 1,
      enqueued: 0,
      finalized: 1,
      pending: 0,
    });
    expect(queue.add).not.toHaveBeenCalled();
    expect(await statusOf(placeholder)).toMatchObject({ status: "done", terminal_outcome: "complete" });
    expect(await statusOf(committed)).toMatchObject({ status: "pending" });
  });

  // Обратная сторона: настоящая сборка без результата обязана остаться работой.
  it("still dispatches a build that has not written a result yet", async () => {
    const placeholder = await insertPlan(pool, "building");
    const queue = { add: vi.fn(async () => ({})) };

    await expect(reconcileBuildingAutopilotPlans({ pool, queue })).resolves.toEqual({
      scanned: 1,
      enqueued: 1,
      finalized: 0,
      pending: 0,
    });
    expect(queue.add).toHaveBeenCalledWith(
      "autopilot-plan",
      { projectId: project, userId: actor, channelId: channel, planId: placeholder },
      expect.objectContaining({ jobId: `autopilot-plan-${placeholder}` }),
    );
    expect(await statusOf(placeholder)).toMatchObject({ status: "building" });
  });

  it("detects the committed result with the same predicate the worker uses", async () => {
    const placeholder = await insertPlan(pool, "building");
    const probe = async () =>
      (await pool.query(
        `select ${committedAutopilotResultExistsSql("autopilot_plan")} as result_committed
           from autopilot_plan where id = $1`,
        [placeholder],
      )).rows[0].result_committed;

    expect(await probe()).toBe(false);
    await insertPlan(pool, "approved", { selectedCount: 5 });
    expect(await probe()).toBe(true);
  });

  // Успешная транзакция воркера: результат записан — плейсхолдер закрыт в том же коммите,
  // прежние незавершённые попытки канала уходят в архив и не всплывают карточкой
  // «Сборка остановилась» над только что собранным планом.
  it("finalizes the placeholder and archives earlier attempts in one transaction", async () => {
    const placeholder = await insertPlan(pool, "building");
    const failedAttempt = await insertPlan(pool, "error", { requestedBy: "human", primaryFix: "provider_retry" });
    const pausedAttempt = await insertPlan(pool, "partial", { requestedBy: "human", recoveryState: "paused_by_user" });

    const tx = await pool.connect();
    let committedPlan = 0;
    try {
      await tx.query("begin");
      committedPlan = await insertPlan(tx, "pending", { selectedCount: 5 });
      await expect(finalizeAutopilotBuildPlaceholder(tx, {
        projectId: project,
        channelId: channel,
        planId: placeholder,
        resultPlanId: committedPlan,
      })).resolves.toEqual({ finalized: true });
      await expect(supersedeAutopilotAttempts(tx, {
        projectId: project,
        channelId: channel,
        keepPlanId: committedPlan,
      })).resolves.toEqual({ superseded: 2 });
      await tx.query("commit");
    } finally {
      tx.release();
    }

    expect(committedPlan).toBeGreaterThan(0);
    expect(await statusOf(placeholder)).toMatchObject({ status: "done", terminal_outcome: "complete" });
    expect((await statusOf(placeholder)).build_report).toMatchObject({ resultPlanId: committedPlan });
    expect(await statusOf(failedAttempt)).toMatchObject({ status: "done" });
    expect(await statusOf(pausedAttempt)).toMatchObject({ status: "done" });
    expect(await statusOf(committedPlan)).toMatchObject({ status: "pending" });
  });

  it("never finalizes a placeholder that another build owns", async () => {
    const other = await insertPlan(pool, "error");
    const finalized = await finalizeAutopilotBuildPlaceholder(pool, {
      projectId: project,
      channelId: channel,
      planId: other,
      resultPlanId: null,
    });

    expect(finalized).toEqual({ finalized: false });
    expect(await statusOf(other)).toMatchObject({ status: "error" });
  });

  it("archives every earlier attempt when no plan has to be spared", async () => {
    const failedAttempt = await insertPlan(pool, "error", { requestedBy: "human" });
    const partialAttempt = await insertPlan(pool, "partial", { requestedBy: "human" });

    await expect(supersedeAutopilotAttempts(pool, { projectId: project, channelId: channel }))
      .resolves.toEqual({ superseded: 2 });
    expect(await statusOf(failedAttempt)).toMatchObject({ status: "done" });
    expect(await statusOf(partialAttempt)).toMatchObject({ status: "done" });
  });
});
