import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";

// Главная проверка исправления: план автопилота обязан быть виден в ОСНОВНОМ календаре
// ещё до подтверждения, а подтверждение из календаря — создавать ту самую публикацию,
// которую видит /api/posts. Работает на одноразовой локальной базе.

const mock = vi.hoisted(() => ({ pool: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: mock.pool }));
vi.mock("@/lib/session", () => ({
  getSessionUser: async (req: NextRequest) => ({ id: Number(req.headers.get("x-test-user")) }),
}));
vi.mock("@/lib/autopilot", async (original) => ({
  ...await original<typeof import("@/lib/autopilot")>(),
  enqueueAutopilotPost: mock.enqueue,
}));

import { POST as approvePOST } from "@/app/api/autopilot/approve/route";
import { GET as calendarPlanGET } from "@/app/api/autopilot/calendar-plan/route";
import { GET as postsGET } from "@/app/api/posts/route";

const target = new URL(String(process.env.DATABASE_URL));
if (target.hostname !== "127.0.0.1" || !["55437", "5432"].includes(target.port)) {
  throw new Error("Isolated local PostgreSQL required");
}
const admin = new pg.Pool({ connectionString: target.href });
const database = `aurora_autopilot_calendar_${randomUUID().replaceAll("-", "")}`;
target.pathname = `/${database}`;
const pool = new pg.Pool({ connectionString: target.href, max: 8 });
const TZ = "Europe/Amsterdam";
const SCHEDULED = "2030-04-10T10:00:00.000Z";

let owner: number, author: number, project: number, foreign: number, channel: number, plan: number;

/** Proof that clears the automatic quality gate (см. post-quality.mjs). */
const verifiedQuality = () => ({
  score: 92,
  threshold: 85,
  passed: true,
  blockers: [],
  violations: [],
  publicationDisposition: "ready",
  metadata: {
    checkedAt: "2026-10-01T09:00:00.000Z",
    rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
    provenance: { kind: "deterministic", validator: "validatePostQuality", trigger: "generation" },
  },
  semantic: {
    version: 1,
    status: "passed",
    passed: true,
    requiresReview: false,
    claimVerdicts: [{ verdict: "supported", sourceSpans: [{ sourceId: "src-1", start: 0, end: 12 }] }],
    provenance: {
      validatorVersion: "semantic-publication-v1",
      checkedAt: "2026-10-01T09:00:00.000Z",
      terminalVerdict: "passed",
      provider: "navy",
    },
  },
});

const planItem = (overrides: Record<string, unknown> = {}) => ({
  i: 0,
  scheduledAt: SCHEDULED,
  topic: "Как вайб-кодинг экономит время",
  draft: "Полный текст публикации автопилота",
  status: "pending",
  quality: verifiedQuality(),
  ...overrides,
});

function request(path: string, options: { user?: number; project?: number; method?: string; body?: unknown } = {}) {
  const method = options.method ?? "GET";
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "x-test-user": String(options.user ?? owner),
      "x-aurora-project-id": String(options.project ?? project),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
}

const planCards = async (options: { user?: number; project?: number } = {}) => {
  const response = await calendarPlanGET(request("/api/autopilot/calendar-plan", options));
  return { status: response.status, body: await response.json() };
};

const calendarPosts = async (projectId = project) => {
  const response = await postsGET(request(
    `/api/posts?view=range&from=2030-04-01&to=2030-05-01&timezone=${encodeURIComponent(TZ)}`,
    { project: projectId },
  ));
  expect(response.status).toBe(200);
  return (await response.json()).posts as Array<Record<string, unknown>>;
};

const postRows = async () => (await pool.query("select id, status, publication_origin, scheduled_at from posts where project_id = $1", [project])).rows;

const confirmFromCalendar = (
  idempotencyKey: string,
  preview: { token: string; revision: number; hash: string },
  options: { user?: number; project?: number } = {},
) => approvePOST(request("/api/autopilot/approve", {
  method: "POST",
  body: {
    channelId: channel,
    action: "confirm",
    selectedIndexes: [0],
    planId: plan,
    idempotencyKey,
    previewToken: preview.token,
    planRevision: preview.revision,
    previewHash: preview.hash,
  },
  ...options,
}));

const addFromCalendar = async (options: { user?: number; project?: number } = {}) => {
  const idempotencyKey = `calendar-${randomUUID()}`;
  const preview = await approvePOST(request("/api/autopilot/approve", {
    method: "POST",
    body: { channelId: channel, action: "preview", selectedIndexes: [0], planId: plan, planRevision: 1 },
    ...options,
  }));
  const previewBody = await preview.json();
  expect(preview.status).toBe(200);
  expect(previewBody.preview).toMatchObject({ complete: true, counts: { eligible: 1 } });
  const confirm = await confirmFromCalendar(idempotencyKey, previewBody.preview, options);
  return { key: idempotencyKey, preview: previewBody.preview, status: confirm.status, body: await confirm.json() };
};

beforeAll(async () => {
  await admin.query(`create database ${database}`);
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: target.href }, logger: { log() {} } });
}, 120_000);

beforeEach(async () => {
  vi.clearAllMocks();
  mock.pool.mockReturnValue(pool);
  mock.enqueue.mockResolvedValue(undefined);
  await pool.query("truncate users, projects cascade");
  owner = Number((await pool.query("insert into users(email) values('owner@example.test') returning id")).rows[0].id);
  author = Number((await pool.query("insert into users(email) values('author@example.test') returning id")).rows[0].id);
  [project, foreign] = (await pool.query(
    "insert into projects(name,timezone,created_by_user_id) values('Аврора',$2,$1),('Чужой','UTC',$1) returning id",
    [owner, TZ],
  )).rows.map((row) => Number(row.id));
  await pool.query(
    "insert into project_members(project_id,user_id,role) values($1,$3,'owner'),($2,$3,'owner'),($1,$4,'author')",
    [project, foreign, owner, author],
  );
  await pool.query("insert into user_project_preferences(user_id,selected_project_id) values($1,$2)", [owner, project]);
  channel = Number((await pool.query(
    "insert into channels(user_id,project_id,network,title,tg_chat_id,is_active) values($1,$2,'tg','ТехнологИИ Права',-1009000001,true) returning id",
    [owner, project],
  )).rows[0].id);
  plan = Number((await pool.query(
    `insert into autopilot_plan(user_id, project_id, channel_id, week_start, status, items, revision, publication_target_count)
     values($1,$2,$3,current_date,'pending',$4::jsonb,1,1) returning id`,
    [owner, project, channel, JSON.stringify([planItem()])],
  )).rows[0].id);
});

afterAll(async () => {
  await pool.end();
  await admin.query(`drop database ${database}`);
  await admin.end();
});

describe.sequential("План автопилота в основном календаре", () => {
  it("показывает неподтверждённый пост в основном календаре, где публикаций ещё нет", async () => {
    // Ровно жалоба пользователя: план собран, календарь пуст.
    expect(await calendarPosts()).toEqual([]);

    const { status, body } = await planCards();
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      key: `plan-${plan}-0`,
      planId: plan,
      planRevision: 1,
      index: 0,
      channelId: channel,
      channelTitle: "ТехнологИИ Права",
      scheduledAt: SCHEDULED,
      state: "ready",
      statusLabel: "Не подтверждён",
      selectable: true,
    });
  });

  it("не показывает план другого проекта", async () => {
    const { body } = await planCards({ project: foreign });
    expect(body.items).toEqual([]);
  });

  it("автор без права публикации видит карточку, но не может её подтвердить", async () => {
    const { body } = await planCards({ user: author });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ state: "ready", selectable: false, editable: true });
  });

  it("просит новое время у прошедшего поста и не даёт его подтвердить", async () => {
    await pool.query("update autopilot_plan set items = $2::jsonb where id = $1", [
      plan,
      JSON.stringify([planItem({ scheduledAt: "2020-01-01T10:00:00.000Z" })]),
    ]);
    const { body } = await planCards();
    expect(body.items[0]).toMatchObject({ state: "expired", statusLabel: "Нужно новое время", selectable: false });
    expect(body.items[0].issues.join(" ")).toContain("прошло");
  });

  it("не дублирует пост, который уже стал публикацией", async () => {
    const post = Number((await pool.query(
      `insert into posts(user_id,project_id,channel_id,text,status,scheduled_at,publication_origin)
       values($1,$2,$3,'Уже в календаре','scheduled',$4,'autopilot') returning id`,
      [owner, project, channel, SCHEDULED],
    )).rows[0].id);
    await pool.query("update autopilot_plan set items = $2::jsonb where id = $1", [
      plan,
      JSON.stringify([planItem({ postId: post, status: "approved" })]),
    ]);
    const { body } = await planCards();
    expect(body.items).toEqual([]);
    expect(await calendarPosts()).toHaveLength(1);
  });

  it("добавление из календаря создаёт публикацию, видимую в основном календаре", async () => {
    const result = await addFromCalendar();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, scheduled: 1 });

    const posts = await calendarPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      status: "scheduled",
      publication_origin: "autopilot",
      scheduled_at: SCHEDULED,
      text: "Полный текст публикации автопилота",
    });
    expect(mock.enqueue).toHaveBeenCalledTimes(1);

    // Карточка плана исчезает: её место занимает реальная публикация, дубля нет.
    const after = await planCards();
    expect(after.body.items).toEqual([]);
    expect((await pool.query("select status from autopilot_plan where id=$1", [plan])).rows[0].status).toBe("approved");
  });

  it("повторное подтверждение тем же ключом не создаёт второй пост", async () => {
    const first = await addFromCalendar();
    expect(first.body).toMatchObject({ ok: true, scheduled: 1 });
    const replay = await confirmFromCalendar(first.key, first.preview);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, scheduled: 1 });
    expect(await postRows()).toHaveLength(1);
    expect(mock.enqueue).toHaveBeenCalledTimes(1);
  });

  it("повторное подтверждение с новым ключом после успеха не создаёт дубль", async () => {
    const first = await addFromCalendar();
    expect(first.body).toMatchObject({ ok: true, scheduled: 1 });
    const second = await confirmFromCalendar(`calendar-${randomUUID()}`, first.preview);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ ok: false, error: "stale_preview" });
    expect(await postRows()).toHaveLength(1);
    expect(mock.enqueue).toHaveBeenCalledTimes(1);
  });

  it("не подтверждает пост, если план изменился после предпросмотра", async () => {
    const preview = await approvePOST(request("/api/autopilot/approve", {
      method: "POST",
      body: { channelId: channel, action: "preview", selectedIndexes: [0], planId: plan, planRevision: 1 },
    }));
    const previewBody = await preview.json();
    await pool.query("update autopilot_plan set items = $2::jsonb, revision = revision + 1 where id = $1", [
      plan,
      JSON.stringify([planItem({ draft: "Текст изменён после предпросмотра" })]),
    ]);
    const confirm = await approvePOST(request("/api/autopilot/approve", {
      method: "POST",
      body: {
        channelId: channel,
        action: "confirm",
        selectedIndexes: [0],
        planId: plan,
        idempotencyKey: `calendar-${randomUUID()}`,
        previewToken: previewBody.preview.token,
        planRevision: previewBody.preview.revision,
        previewHash: previewBody.preview.hash,
      },
    }));
    expect(confirm.status).toBe(409);
    expect(await confirm.json()).toMatchObject({ ok: false, error: "stale_preview" });
    expect(await postRows()).toEqual([]);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });

  it("показывает новый план, пока прежний подтверждается, и не выдаёт устаревший", async () => {
    // Прежний план застрял в approving (подтверждение оборвалось) — его нельзя показывать,
    // пока существует более новый живой план канала.
    await pool.query("update autopilot_plan set status = 'approving' where id = $1", [plan]);
    const newer = Number((await pool.query(
      `insert into autopilot_plan(user_id, project_id, channel_id, week_start, status, items, revision, publication_target_count)
       values($1,$2,$3,current_date,'pending',$4::jsonb,1,1) returning id`,
      [owner, project, channel, JSON.stringify([planItem({ i: 0, topic: "Новый план", draft: "Текст нового плана" })])],
    )).rows[0].id);

    const { body } = await planCards();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ planId: newer, topic: "Новый план", selectable: true });

    // Пока новый план подтверждается, старый возвращается из approving в pending —
    // календарь по-прежнему обязан показывать только новый.
    await pool.query("update autopilot_plan set status = 'approving' where id = $1", [newer]);
    await pool.query("update autopilot_plan set status = 'pending', revision = revision + 1 where id = $1", [plan]);
    const during = await planCards();
    expect(during.body.items).toEqual([]);
  });

  it("не обещает добавление, если в редакторе сохранены новые правки", async () => {
    const draft = Number((await pool.query(
      "insert into drafts(user_id,project_id,text,version,client_key) values($1,$2,'Новая версия текста',5,$3) returning id",
      [owner, project, `editor-${randomUUID()}`],
    )).rows[0].id);
    await pool.query("update autopilot_plan set items = $2::jsonb where id = $1", [
      plan,
      JSON.stringify([planItem({ draftId: draft, editorVersion: 4 })]),
    ]);

    const { body } = await planCards();
    expect(body.items[0]).toMatchObject({ state: "blocked", selectable: false });
    expect(body.items[0].issues.join(" ")).toContain("правки");
  });
});
