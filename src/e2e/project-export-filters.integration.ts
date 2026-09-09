import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";

const selection = vi.hoisted(() => ({ projectId: 0 }));
vi.mock("@/lib/request-project", () => ({ requestProjectId: async () => selection.projectId }));
import { createProjectExportOperation, previewProjectExport } from "@/lib/project-export-service";
import { renderProjectCsv } from "@/lib/project-export.mjs";

const databaseUrl = process.env.PROJECT_EXPORT_TEST_DATABASE_URL ?? "";
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  || !["postgres:", "postgresql:"].includes(target.protocol) || target.pathname !== "/aurora_export_filters_test") {
  throw new Error("Requires disposable loopback PROJECT_EXPORT_TEST_DATABASE_URL for aurora_export_filters_test");
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
let user = 0;
let published = 0;
let unknown = 0;
const unicodePosts = new Map<string, number>();
const period = { from: "2026-08-01", to: "2026-08-31" };
const id = async (sql: string, values: unknown[] = []) => Number((await pool.query(sql, values)).rows[0].id);
const preview = (filters: Record<string, string>, dates = period) => previewProjectExport({
  db: pool, actorUserId: user, body: { kind: "content_plan", format: "csv", period: dates, filters },
});

beforeAll(async () => {
  const database = (await pool.query("select datcollate,datctype from pg_database where datname=current_database()")).rows[0];
  expect(database).toEqual({ datcollate: "C", datctype: "C" });
  expect((await pool.query("show server_encoding")).rows[0].server_encoding).toBe("UTF8");
  expect(Number((await pool.query("show server_version_num")).rows[0].server_version_num)).toBeGreaterThanOrEqual(170000);
  expect((await pool.query("select collprovider from pg_collation where oid='pg_catalog.pg_c_utf8'::regcollation")).rows[0].collprovider).toBe("b");
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { DATABASE_URL: databaseUrl }, logger: { log() {} } });
  user = await id("insert into users(email,name)values('export-owner@example.test','Анна') returning id");
  const otherUser = await id("insert into users(email,name)values('export-noise@example.test','Другой') returning id");
  selection.projectId = await id("insert into projects(name,created_by_user_id,timezone)values('Экспорт',$1,'UTC') returning id", [user]);
  const foreign = await id("insert into projects(name,created_by_user_id,timezone)values('Чужой',$1,'UTC') returning id", [otherUser]);
  await pool.query("insert into project_members(project_id,user_id,role)values($1,$2,'owner')", [selection.projectId, user]);
  const channel = await id("insert into channels(user_id,project_id,network,tg_chat_id,title)values($1,$2,'tg',-10047001,'ТехнологИИ Права') returning id", [user, selection.projectId]);
  const noiseChannel = await id("insert into channels(user_id,project_id,network,tg_chat_id,title)values($1,$2,'tg',-10047002,'Другой канал') returning id", [otherUser, selection.projectId]);
  const foreignChannel = await id("insert into channels(user_id,project_id,network,tg_chat_id,title)values($1,$2,'tg',-10047003,'ТехнологИИ Права') returning id", [otherUser, foreign]);
  // Earlier nonmatching rows must not consume the bounded source read.
  await pool.query(`insert into posts(user_id,project_id,channel_id,text,status,scheduled_at)
    select $1,$2,$3,'Шум '||n,'draft','2026-08-10T10:00:00Z'::timestamptz from generate_series(1,25001)n`, [otherUser, selection.projectId, noiseChannel]);
  published = await id("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at,published_at)values($1,$2,$3,'Подтверждённый пост','published','2026-08-11T10:00:00Z','2026-08-11T10:00:00Z') returning id", [user, selection.projectId, channel]);
  await pool.query("update posts set verification_state='verified' where id=$1", [published]);
  unknown = await id("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at)values($1,$2,$3,'Неопределённая доставка','published_unverified','2026-08-11T11:00:00Z') returning id", [user, selection.projectId, channel]);
  await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at)values($1,$2,$3,'Чужой пост','published','2026-08-11T10:00:00Z')", [otherUser, foreign, foreignChannel]);
  await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at)values($1,$2,$3,'За периодом','published','2026-09-01T00:00:00Z')", [user, selection.projectId, channel]);
  const campaign = await id(`insert into monthly_campaigns(project_id,created_by_user_id,updated_by_user_id,goal,starts_on,ends_on,timezone,rubrics,practice_mix,audience,funnel_stages,posts_per_week,profile_version,content_brief_version,profile_hash,brief_hash,request_key,request_hash)
    values($1,$2,$2,'Кампания','2026-08-01','2026-08-31','UTC',array['А','Б','В'],'[]','Клиенты',array['awareness'],1,1,1,$3,$3,'n47-campaign',$3) returning id`, [selection.projectId, user, "a".repeat(64)]);
  const plan = await id(`insert into monthly_campaign_plans(project_id,campaign_id,revision,source_campaign_version,source_brief_hash,source_profile_hash,source_profile_version,source_content_brief_version,request_key,request_hash,created_by_user_id)
    values($1,$2,1,1,$3,$3,1,1,'n47-plan',$3,$4) returning id`, [selection.projectId, campaign, "a".repeat(64), user]);
  for (const [index, post] of [published, unknown].entries()) await pool.query(`insert into monthly_campaign_items(project_id,plan_id,item_key,scheduled_for,position,title,rubric,practice,funnel_stage,post_id)
    values($1,$2,$3,'2026-08-11'::date+$4::integer,$4,'Тема','Практика','Право','awareness',$5)`, [selection.projectId, plan, `n47-item-${index}`, index, post]);
  for (const [index, name] of ["ΟΣ", "İ", "ABC", "Е\u0308Ж"].entries()) {
    const channel = await id("insert into channels(user_id,project_id,network,tg_chat_id,title)values($1,$2,'tg',$3,$4) returning id", [user, selection.projectId, -10047100 - index, name]);
    unicodePosts.set(name, await id("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at)values($1,$2,$3,$4,'published','2026-09-02T12:00:00Z') returning id", [user, selection.projectId, channel, `Unicode ${name}`]));
  }
}, 30_000);

afterAll(async () => { await pool.end(); });

describe("N47 Unicode export filters on C-locale PostgreSQL", () => {
  it("proves the C locale reproducer and required built-in Unicode capability", async () => {
    expect((await pool.query("select lower('Опубликован') as c,lower('Опубликован' collate pg_catalog.pg_c_utf8) as unicode")).rows[0])
      .toEqual({ c: "Опубликован", unicode: "опубликован" });
  });

  it.each([
    ["confirmed key", { status: "published" }, "published"],
    ["confirmed mixed case", { status: "ОПУБЛИКОВАН" }, "published"],
    ["unknown key", { status: "published_unverified" }, "unknown"],
    ["unknown mixed case", { status: "ДОСТАВКА НЕ ПОДТВЕРЖДЕНА" }, "unknown"],
    ["Cyrillic channel", { channel: "технологии права" }, "both"],
    ["Cyrillic author", { author: "аНнА" }, "both"],
    ["Cyrillic campaign", { campaign: "кАмПаНиЯ" }, "both"],
    ["all dimensions", { channel: "ТЕХНОЛОГИИ ПРАВА", author: "анна", campaign: "КАМПАНИЯ", status: "published" }, "published"],
  ] as const)("matches %s before LIMIT without foreign project or date leakage", async (_label, filters, expected) => {
    const result = await preview(filters);
    const ids = expected === "both" ? [published, unknown] : [expected === "published" ? published : unknown];
    expect(result.rowCount).toBe(ids.length);
    expect(result.sample.map(row => row.id)).toEqual(ids.map(String));
    expect(result.exceedsLimit).toBe(false);
  });

  it.each([
    ["Greek sigma", "ΟΣ", "οσ", true],
    ["Greek final sigma remains distinct under simple lowercase", "ΟΣ", "ος", false],
    ["dotted I", "İ", "i", true],
    ["combining dot remains distinct under simple lowercase", "İ", "i\u0307", false],
    ["ASCII", "ABC", "abc", true],
    ["Cyrillic NFKC", "Е\u0308Ж", "ёж", true],
  ] as const)("keeps SQL, snapshot and artifact consistent for %s", async (_label, source, filter, matches) => {
    const sql = (await pool.query("select lower(normalize($1,NFKC) collate pg_catalog.pg_c_utf8)=lower(normalize($2,NFKC) collate pg_catalog.pg_c_utf8) as matches", [source, filter])).rows[0].matches;
    expect(sql).toBe(matches);
    const body = { kind: "content_plan" as const, format: "csv" as const, period: { from: "2026-09-01", to: "2026-09-30" }, filters: { channel: filter } };
    const result = await previewProjectExport({ db: pool, actorUserId: user, body });
    expect(result.sample.map(row => row.id)).toEqual(matches ? [String(unicodePosts.get(source))] : []);
    const operation = await createProjectExportOperation({ pool, actorUserId: user, requestKey: randomUUID(), body: { ...body, previewHash: result.previewHash } });
    const snapshot = (await pool.query("select snapshot from project_export_operations where id=$1", [operation.id])).rows[0].snapshot;
    expect(snapshot.rows.map((row: { id: string }) => row.id)).toEqual(matches ? [String(unicodePosts.get(source))] : []);
    const csv = renderProjectCsv(snapshot).toString("utf8");
    expect(csv.includes(`Unicode ${source}`)).toBe(matches);
  });

  it("applies the same Cyrillic dimensions to verified analytics without including unknown delivery", async () => {
    const result = await previewProjectExport({ db: pool, actorUserId: user, body: {
      kind: "analytics", format: "csv", period,
      filters: { channel: "ТЕХНОЛОГИИ ПРАВА", author: "аНнА", campaign: "кАмПаНиЯ", status: "ПОДТВЕРЖДЕНО" },
    } });
    expect(result.rowCount).toBe(1);
    expect(result.sample.map(row => ({ id: row.id, status: row.status }))).toEqual([{ id: String(published), status: "Подтверждено" }]);
  });

  it("keeps nonmatching filters empty and enforces the selected date range", async () => {
    expect((await preview({ channel: "НЕСУЩЕСТВУЮЩИЙ" })).rowCount).toBe(0);
    expect((await preview({ status: "published" }, { from: "2026-08-12", to: "2026-08-13" })).rowCount).toBe(0);
    await expect(preview({}, { from: "2025-01-01", to: "2026-08-31" })).rejects.toMatchObject({ code: "invalid_period" });
  });

  it("persists the exact filtered unknown row and renders truthful CSV with real authorization", async () => {
    const body = { kind: "content_plan" as const, format: "csv" as const, period,
      filters: { channel: "ТЕХНОЛОГИИ ПРАВА", author: "АННА", campaign: "КАМПАНИЯ", status: "published_unverified" } };
    const selection = await previewProjectExport({ db: pool, actorUserId: user, body });
    expect(selection.rowCount).toBe(1);
    const operation = await createProjectExportOperation({ pool, actorUserId: user, requestKey: randomUUID(), body: { ...body, previewHash: selection.previewHash } });
    const stored = (await pool.query("select snapshot from project_export_operations where id=$1", [operation.id])).rows[0].snapshot;
    expect(stored.rows.map((row: { id: string }) => row.id)).toEqual([String(unknown)]);
    const csv = renderProjectCsv(stored).toString("utf8");
    expect(csv).toContain("Доставка не подтверждена");
    expect(csv).not.toContain("Чужой пост");
    expect(csv).not.toContain("За периодом");
  });
});
