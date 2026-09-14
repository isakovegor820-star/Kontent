import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { hashPassword } from "@/lib/password";

const mocks = vi.hoisted(() => ({ pool: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: mocks.pool }));
import { loadTodayBoard, updateTodayItemState, setTodayRecommendationPreference } from "@/lib/today";
import { recordDraftRevisionInTransaction } from "@/lib/editorial-approval";
import { listOpportunitySnapshots } from "@/lib/content-intelligence";
import { ensureGrowthBoard } from "@/lib/growth";
import { loadTodayPublications } from "@/lib/today-publications";
import { materializeAllOpportunitySnapshots } from "@/lib/opportunity-snapshot-materializer.mjs";

const url = new URL(process.env.TODAY_TEST_DATABASE_URL || "http://invalid");
if (!["localhost", "127.0.0.1"].includes(url.hostname) || !/^\/aurora_today_review_\d+$/u.test(url.pathname)) {
  throw new Error("TODAY_TEST_DATABASE_URL must name an isolated local aurora_today_review database");
}
const pool = new pg.Pool({ connectionString: url.href, max: 4 });
let userId: number, projectId: number, channelId: number, competitorId: number, otherChannel: number;
let initialCount: number;
const scope = () => ({ projectId, channelId, timezone: "Europe/Amsterdam", canPublish: true });

beforeAll(async () => {
  mocks.pool.mockReturnValue(pool);
  const email = `today-${randomUUID()}@example.test`;
  const password = "Today-review-2026!";
  userId = Number((await pool.query("insert into users(email,password_hash,name) values($1,$2,'Проверка Сегодня') returning id", [email, await hashPassword(password)])).rows[0].id);
  projectId = Number((await pool.query("insert into projects(name,created_by_user_id,timezone) values('Сегодня · проверка',$1,'Europe/Amsterdam') returning id", [userId])).rows[0].id);
  await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'owner')", [projectId, userId]);
  await pool.query("insert into user_project_preferences(user_id,selected_project_id) values($1,$2)", [userId, projectId]);
  channelId = Number((await pool.query("insert into channels(user_id,project_id,network,tg_chat_id,title,status) values($1,$2,'tg',$3,'Тестовый канал','active') returning id", [userId, projectId, -1000000-userId])).rows[0].id);
  const otherProject = Number((await pool.query("insert into projects(name,created_by_user_id) values('Другой проект',$1) returning id", [userId])).rows[0].id);
  otherChannel = Number((await pool.query("insert into channels(user_id,project_id,network,tg_chat_id,title,status) values($1,$2,'tg',$3,'Другой канал','active') returning id", [userId, otherProject, -2000000-userId])).rows[0].id);
  await pool.query("insert into channel_feature_flags(project_id,channel_id,feature_key,enabled,enabled_at) values($1,$2,'content_intelligence_release_1',true,now()) on conflict(project_id,channel_id,feature_key) do update set enabled=true,enabled_at=now()", [projectId, channelId]);
  competitorId = Number((await pool.query("insert into competitors(user_id,channel_id,network,handle,title,status) values($1,$2,'tg',$3,'Источник тем','ready') returning id", [userId, channelId, `fixture_${userId}`])).rows[0].id);
  await pool.query(`insert into competitor_posts(competitor_id,tg_msg_id,text,views,posted_at,is_hit)
    select $1, i, 'Сюжет' || i || ' Подробности' || i || ' Решение' || i, 500, now()-make_interval(hours=>i), true
    from generate_series(1,24) i`, [competitorId]);
  await pool.query("insert into audience_questions(created_by_user_id,project_id,question,status,question_fingerprint) values($1,$2,'Какие документы нужны для консультации?','new',repeat('a',64)),($1,$2,'Как выбрать формат сотрудничества?','new',repeat('b',64))", [userId, projectId]);
  writeFileSync("/tmp/aurora-today-review-user.json", JSON.stringify({ email, password, userId, projectId, channelId }), { mode: 0o600 });
});
afterAll(async () => { await pool.end(); });

it("the real background path discovers multiple themes and audience questions without visiting Growth", async () => {
  const result = await materializeAllOpportunitySnapshots(pool);
  expect(result.failed).toBe(0);
  const rows = (await pool.query("select kind from growth_moves where project_id=$1 and channel_id=$2", [projectId, channelId])).rows;
  expect(rows.filter(row => row.kind === "topic")).toHaveLength(24);
  expect(rows.filter(row => row.kind === "audience")).toHaveLength(2);
  initialCount = rows.length;
  const count = Number((await pool.query("select count(*) from opportunity_snapshots where project_id=$1", [projectId])).rows[0].count);
  expect(count).toBe(26);
  const opportunities = await listOpportunitySnapshots({ actorUserId: userId, channelId }, pool);
  expect(opportunities).toHaveLength(26);
  expect(opportunities.every(item => item.actionable && item.actionHref?.startsWith("/app/studio?growthMove="))).toBe(true);
});

it("new evidence adds a move during the same week and a repeated refresh creates no duplicates", async () => {
  await pool.query("insert into competitor_posts(competitor_id,tg_msg_id,text,views,posted_at,is_hit) values($1,99,'Новая история про исследование рынка',900,now(),true)", [competitorId]);
  await ensureGrowthBoard({ actorUserId: userId, channelId });
  expect(Number((await pool.query("select count(*) from growth_moves where project_id=$1", [projectId])).rows[0].count)).toBe(initialCount + 1);
  expect((await materializeAllOpportunitySnapshots(pool)).failed).toBe(0);
  expect((await materializeAllOpportunitySnapshots(pool)).inserted).toBe(0);
});

it("rejects a channel outside the selected project", async () => {
  await expect(loadTodayBoard({ actorUserId: userId, channelId: otherChannel }, pool)).rejects.toMatchObject({ code: "channel_not_found" });
});

it("returns hidden categories after reload and restores them persistently", async () => {
  await setTodayRecommendationPreference({ actorUserId: userId, channelId, recommendationKind: "opportunity", state: "hidden" }, pool);
  const hidden = await loadTodayBoard({ actorUserId: userId, channelId }, pool);
  expect(hidden.hiddenRecommendationKinds).toContain("opportunity");
  expect(hidden.items.some(item => item.recommendationKind === "opportunity")).toBe(false);
  await setTodayRecommendationPreference({ actorUserId: userId, channelId, recommendationKind: "opportunity", state: "active" }, pool);
  expect((await loadTodayBoard({ actorUserId: userId, channelId }, pool)).hiddenRecommendationKinds).not.toContain("opportunity");
});

it("refills beyond the SQL page after completing more than twenty opportunities", async () => {
  const completed = new Set<string>();
  for (let i = 0; i < 27; i++) {
    const board = await loadTodayBoard({ actorUserId: userId, channelId }, pool);
    expect(board.partialErrors).toEqual([]);
    const item = board.items.find(candidate => candidate.type === "opportunity");
    expect(item, `opportunity ${i + 1} must remain reachable`).toBeDefined();
    expect(completed.has(item!.fingerprint)).toBe(false);
    completed.add(item!.fingerprint);
    await updateTodayItemState({ actorUserId: userId, channelId, fingerprint: item!.fingerprint, state: "done" }, pool);
  }
  const board = await loadTodayBoard({ actorUserId: userId, channelId }, pool);
  expect(board.items.some(item => item.type === "opportunity")).toBe(false);
  expect(board.items.some(item => item.type === "risk")).toBe(true);
});

it("lists real delivery and draft states without leaking another channel", async () => {
  const draft = Number((await pool.query("insert into drafts(user_id,project_id,text,client_key,purpose) values($1,$2,'Материал на сегодня',$3,'publishable') returning id", [userId, projectId, randomUUID()])).rows[0].id);
  await pool.query("insert into draft_destinations(draft_id,channel_id) values($1,$2)", [draft, channelId]);
  await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at,published_at) values($1,$2,$3,'Подтверждённая публикация','published',now(),now())", [userId, projectId, channelId]);
  const result = await loadTodayPublications(pool, scope());
  expect(result.find(item => item.draftId === draft)).toMatchObject({ status: "draft", canPublish: false });
  expect(result.some(item => item.status === "published")).toBe(true);
  expect(result.every(item => !item.canPublish)).toBe(true);
  const board = await loadTodayBoard({ actorUserId: userId, channelId }, pool);
  expect(board.publicationQueue?.state).toBe("ready");
  const revision = await recordDraftRevisionInTransaction(pool, { draftId: draft, actorUserId: userId, projectId });
  await pool.query("update draft_editorial_workflows set state='approved', approved_revision_id=$2, approved_content_hash=$3 where draft_id=$1", [draft, revision.id, revision.contentHash]);
  expect((await loadTodayPublications(pool, scope())).find(item => item.draftId === draft)?.canPublish).toBe(true);
  expect((await loadTodayPublications(pool, { ...scope(), canPublish: false })).find(item => item.draftId === draft)?.canPublish).toBe(false);
  await pool.query("update drafts set client_key='autopilot-item:today-fixture' where id=$1", [draft]);
  const autopilot = (await loadTodayPublications(pool, scope())).find(item => item.draftId === draft);
  expect(autopilot?.canPublish).toBe(false);
  expect(autopilot?.href).toBe(`/app/autopilot?channel=${channelId}`);
  await pool.query("update drafts set client_key=$2 where id=$1", [draft, randomUUID()]);
  const secondChannel = Number((await pool.query("insert into channels(user_id,project_id,network,tg_chat_id,title,status) values($1,$2,'tg',$3,'Второй канал','active') returning id", [userId, projectId, -3000000-userId])).rows[0].id);
  await pool.query("insert into draft_destinations(draft_id,channel_id) values($1,$2)", [draft, secondChannel]);
  expect((await loadTodayPublications(pool, scope())).find(item => item.draftId === draft)?.canPublish).toBe(false);
});
