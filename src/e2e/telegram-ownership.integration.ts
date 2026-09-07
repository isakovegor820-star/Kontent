import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { deliverTelegramBackgroundCall } from "../../worker/telegram-background-delivery.mjs";
import { createHmac } from "node:crypto";
import pg from "pg";
import ts from "typescript";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";
import { createTelegramChannelProof, pendingTelegramChannelProof, saveVerifiedTelegramChannel } from "@/lib/telegram-channel-connect.mjs";
import { createLegacyBotLink, consumeLegacyBotLink, createBotConnectionSession, inspectBotConnectionSession, confirmBotConnectionSession } from "@/lib/bot-connection.mjs";

const mocks = vi.hoisted(() => ({ getPool: vi.fn(), getSessionUser: vi.fn(), project: vi.fn(), queueAdd: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/project-permissions", async (original) => ({ ...await original<typeof import("@/lib/project-permissions")>(), requireSelectedProjectPermission: mocks.project }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.queueAdd }) }));
import { POST } from "@/app/api/channels/connect/route";
import { GET as miniAppOverview } from "@/app/api/bot/miniapp/overview/route";

const url = String(process.env.TELEGRAM_OWNERSHIP_TEST_DATABASE_URL || "");
const target = new URL(url);
if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname) || target.pathname !== "/aurora_s01_test") {
  throw new Error("Telegram ownership integration requires disposable local aurora_s01_test database");
}
const pool = new pg.Pool({ connectionString: url, max: 12, ssl: false });
let userId: number;
let foreignUserId: number;
let projectId: number;
let foreignProjectId: number;
const actorId = 123;
const chatId = -100001;
const request = () => new NextRequest("http://localhost/api/channels/connect", {
  method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ handle: "@ownership_test" }),
});
let workerSource: ts.SourceFile;
function workerFunction(name: string, dependencies: Record<string, unknown>) {
  const declaration = workerSource.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing worker function ${name}`);
  // Execute the actual worker entry boundary without starting its runtime or loading .env.
  return new Function(...Object.keys(dependencies), `return (${declaration.getText(workerSource)})`)(...Object.values(dependencies));
}
function notificationDependencies(tgSend: (...args: unknown[]) => unknown, database = pool) {
  return { pool: database, tgTransport: (_method: string, body: Record<string, unknown>) => tgSend(body.chat_id,body.text,body.reply_markup),
    toTelegramHtml: (value: string) => value, keyboard: (value: unknown) => value, TOKEN: "999:isolated-fake-provider",
    deliverTelegramBackgroundCall, BOT_NOTIFICATION_FIELDS: { failure: "publication_failure_enabled", daily: "daily_digest_enabled", weekly: "weekly_digest_enabled" }, console };
}
function miniAppRequest() {
  const values = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: actorId }) };
  const check = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update("999:isolated-fake-provider").digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new NextRequest("http://localhost/api/bot/miniapp/overview", { headers: { "x-telegram-init-data": new URLSearchParams({ ...values, hash }).toString() } });
}
function provider(actorStatus = "creator") {
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const params = JSON.parse(init.body);
    if (!params.user_id) return Response.json({ ok: true, result: { id: chatId, type: "channel", title: "Isolated fixture" } });
    return Response.json({ ok: true, result: params.user_id === actorId
      ? { status: actorStatus, can_post_messages: actorStatus === "administrator" }
      : { status: "administrator", can_post_messages: true } });
  }));
}
async function proof(source: "web" | "telegram" = "web") {
  const result = await createTelegramChannelProof(pool, { userId, projectId, source, ...(source === "web" ? { chatId } : {}) });
  if (result.state !== "ready") throw new Error(result.state);
  return result;
}
async function save(proofId: string, extra = {}) {
  return saveVerifiedTelegramChannel(pool, { userId, projectId, actorId, proofId, chat: { id: chatId, type: "channel" }, ...extra });
}

beforeAll(async () => {
  workerSource = ts.createSourceFile("worker.mjs", await readFile(new URL("../../worker.mjs", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: url }, logger: { log() {} } });
  [userId, foreignUserId] = (await pool.query("insert into users(email, tg_chat_id) values ('owner@fixture.test',123), ('other@fixture.test',456) returning id")).rows.map((r) => Number(r.id));
  [projectId, foreignProjectId] = (await pool.query("insert into projects(name, created_by_user_id) values ('Owner fixture',$1),('Foreign fixture',$2) returning id", [userId, foreignUserId])).rows.map((r) => Number(r.id));
  await pool.query("insert into project_members(project_id,user_id,role) values ($1,$2,'owner'),($3,$4,'owner')", [projectId,userId,foreignProjectId,foreignUserId]);
  mocks.getPool.mockReturnValue(pool);
  mocks.getSessionUser.mockImplementation(async () => ({ id: userId }));
  mocks.project.mockImplementation(async () => ({ projectId }));
  mocks.queueAdd.mockResolvedValue({ id: "fake" });
  vi.stubEnv("TG_BOT_TOKEN", "999:isolated-fake-provider");
});
beforeEach(async () => {
  await pool.query("delete from telegram_background_deliveries");
  await pool.query("delete from channel_events");
  await pool.query("delete from channels");
  await pool.query("delete from telegram_channel_connection_proofs");
  await pool.query("update users set tg_chat_id = 123, blocked_at = null where id = $1", [userId]);
  await pool.query("update project_members set status = 'active', revoked_at = null, role = 'owner' where user_id = $1", [userId]);
  await pool.query("delete from project_members where project_id=$1 and user_id=$2", [foreignProjectId,userId]);
  await pool.query("update projects set is_archived = false where id = $1", [projectId]);
  mocks.getPool.mockReturnValue(pool);
  provider();
});
afterAll(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await pool.end(); });

describe("Telegram ownership safety against real PostgreSQL", () => {
  it("denies a blocked Mini App account with genuine signed initData and permits unblock", async () => {
    await pool.query("insert into user_project_preferences(user_id,selected_project_id) values($1,$2) on conflict(user_id) do update set selected_project_id=$2", [userId,projectId]);
    await pool.query("update users set blocked_at=now() where id=$1", [userId]);
    expect((await miniAppOverview(miniAppRequest())).status).toBe(403);
    await pool.query("update users set blocked_at=null where id=$1", [userId]);
    const allowed = await miniAppOverview(miniAppRequest());
    expect(allowed.status).toBe(200); expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect(await allowed.json()).toMatchObject({ ok: true, overview: { project: "Owner fixture" } });
    expect((await miniAppOverview(new NextRequest("http://localhost/api/bot/miniapp/overview", { headers: { "x-telegram-init-data": "hash=forged" } }))).status).toBe(401);
  });
  it("denies Mini App output when membership is revoked during overview reads", async () => {
    await pool.query("insert into user_project_preferences(user_id,selected_project_id) values($1,$2) on conflict(user_id) do update set selected_project_id=$2", [userId,projectId]);
    mocks.getPool.mockReturnValue({ query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("select post.id, post.text")) await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [projectId,userId]);
      return pool.query(sql, params);
    } });
    const response = await miniAppOverview(miniAppRequest());
    expect(response.status).toBe(403); expect(JSON.stringify(await response.json())).not.toContain("Owner fixture");
  });
  it.each(["blocked", "revoked", "archived", "foreign", "missing_project"])("does not send project notification after %s authority", async (change) => {
    await pool.query("insert into user_project_preferences(user_id,selected_project_id) values($1,$2) on conflict(user_id) do update set selected_project_id=$2", [userId,projectId]);
    if (change === "blocked") await pool.query("update users set blocked_at=now() where id=$1", [userId]);
    if (change === "revoked") await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [projectId,userId]);
    if (change === "archived") await pool.query("update projects set is_archived=true where id=$1", [projectId]);
    const tgSend = vi.fn(async () => ({ ok: true, result: { message_id: 71 } }));
    const notify = workerFunction("notifyUser", notificationDependencies(tgSend));
    const options = change === "missing_project" ? { kind: "failure", eventKey: "permission-test" } : { kind: "failure", projectId: change === "foreign" ? foreignProjectId : projectId, eventKey: "permission-test" };
    expect(await notify(userId, "private project canary", undefined, options)).toBe(false);
    expect(tgSend).not.toHaveBeenCalled();
  });
  it.each(["owner", "author", "approver", "publisher"])("sends notification for an authorized %s in its explicit project regardless of selected preference", async (role) => {
    await pool.query("update project_members set role=$3 where project_id=$1 and user_id=$2", [projectId,userId,role]);
    await pool.query("insert into user_project_preferences(user_id,selected_project_id) values($1,$2) on conflict(user_id) do update set selected_project_id=$2", [userId,foreignProjectId]);
    const tgSend = vi.fn(async () => ({ ok: true, result: { message_id: 71 } }));
    const notify = workerFunction("notifyUser", notificationDependencies(tgSend));
    expect(await notify(userId, "authorized project canary", undefined, { kind: "failure", projectId, eventKey: "permission-test" })).toBe(true);
    expect(tgSend).toHaveBeenCalledWith(String(actorId), "authorized project canary", undefined);
  });
  it("holds a lost background notification acknowledgement across caller retries and restart", async () => {
    let effects = 0;
    const tgSend = vi.fn(async () => { effects += 1; throw Object.assign(new Error("isolated lost acknowledgement"), { deliveryUnknown: true }); });
    const dependencies = notificationDependencies(tgSend);
    const options = { kind: "failure", projectId, eventKey: "digest:daily:2030-01-01" };
    const first = await workerFunction("notifyUser", dependencies)(userId, "one durable event", undefined, options);
    const restarted = await workerFunction("notifyUser", dependencies)(userId, "one durable event", undefined, options);
    expect(effects).toBe(1);
    expect(first).toBeNull(); expect(restarted).toBeNull();
  });
  it("reuses a genuine confirmed background receipt without a second provider effect", async () => {
    const tgSend = vi.fn(async () => ({ ok: true, result: { message_id: 712 } }));
    const dependencies = notificationDependencies(tgSend);
    const options = { kind: "failure", projectId, eventKey: "stats-report:isolated-job-41" };
    expect(await workerFunction("notifyUser", dependencies)(userId, "one durable event", undefined, options)).toBe(true);
    expect(await workerFunction("notifyUser", dependencies)(userId, "one durable event", undefined, options)).toBe(true);
    expect(tgSend).toHaveBeenCalledTimes(1);
  });
  it("holds an invalid success response instead of treating it as confirmed or retryable", async () => {
    const send = vi.fn(async () => ({ ok: true, result: {} }));
    const notify = workerFunction("notifyUser", notificationDependencies(send));
    const options = { projectId, eventKey: "malformed:1" };
    expect(await notify(userId,"receipt required",undefined,options)).toBeNull();
    expect(await notify(userId,"receipt required",undefined,options)).toBeNull();
    expect(send).toHaveBeenCalledOnce();
    expect((await pool.query("select send_status from telegram_background_deliveries")).rows[0].send_status).toBe("unknown");
  });
  it("persists in-flight uncertainty when saving a successful provider receipt fails", async () => {
    const send = vi.fn(async () => ({ ok: true, result: { message_id: 713 } }));
    const failurePool = { query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("set send_status=$8")) throw new Error("isolated receipt storage loss");
      return pool.query(sql,params);
    } } as typeof pool;
    const options = { projectId, eventKey: "receipt-storage-loss:1" };
    expect(await workerFunction("notifyUser",notificationDependencies(send,failurePool))(userId,"one effect",undefined,options)).toBeNull();
    const restart = new pg.Pool({ connectionString: url, ssl: false });
    try {
      expect(await workerFunction("notifyUser",notificationDependencies(send,restart))(userId,"one effect",undefined,options)).toBeNull();
      expect((await restart.query("select send_status from telegram_background_deliveries")).rows[0].send_status).toBe("sending");
    } finally { await restart.end(); }
    const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
      import pg from 'pg';
      import { deliverTelegramBackgroundCall } from './worker/telegram-background-delivery.mjs';
      const pool = new pg.Pool({connectionString:process.env.ISOLATED_DATABASE_URL,ssl:false});
      let calls=0;
      try {
        const outcome = await deliverTelegramBackgroundCall({pool,userId:${userId},projectId:${projectId},eventKey:'receipt-storage-loss:1',botId:999,chatId:${actorId},body:{chat_id:'${actorId}',text:'one effect',parse_mode:'HTML',disable_web_page_preview:true},send:async()=>{calls++;throw new Error('unexpected external boundary');}});
        console.log(JSON.stringify({outcome,calls}));
      } finally { await pool.end(); }
    `], { cwd: new URL("../../",import.meta.url), env: { NODE_ENV:"test", ISOLATED_DATABASE_URL:url } });
    expect(JSON.parse(child.stdout)).toMatchObject({outcome:{kind:"unknown"},calls:0});
    expect(send).toHaveBeenCalledOnce();
  });
  it("allows one provider call for concurrent workers and reuses its confirmed receipt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release=resolve; });
    const send = vi.fn(async () => { await gate; return { ok:true,result:{ message_id:714 } }; });
    const notify = workerFunction("notifyUser",notificationDependencies(send));
    const options = { projectId,eventKey:"concurrent:1" };
    const first = notify(userId,"one effect",undefined,options);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(await notify(userId,"one effect",undefined,options)).toBeNull();
    release(); expect(await first).toBe(true);
    expect(await notify(userId,"one effect",undefined,options)).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });
  it("retries only a definitive provider rejection after its retry_after deadline", async () => {
    const send = vi.fn().mockResolvedValueOnce({ ok:false,error_code:429,parameters:{retry_after:30} }).mockResolvedValue({ ok:true,result:{message_id:715} });
    const notify = workerFunction("notifyUser",notificationDependencies(send));
    const options = { projectId,eventKey:"rejected:1" };
    expect(await notify(userId,"one effect",undefined,options)).toBe(false);
    expect(await notify(userId,"one effect",undefined,options)).toBe(false); expect(send).toHaveBeenCalledOnce();
    await pool.query("update telegram_background_deliveries set retry_not_before=now()-interval '1 second'");
    expect(await notify(userId,"one effect",undefined,options)).toBe(true); expect(send).toHaveBeenCalledTimes(2);
  });
  it("holds a changed payload or destination and never repeats an already successful part", async () => {
    const sendFirst = vi.fn(async () => ({ ok:true,result:{message_id:716} }));
    const sendSecond = vi.fn(async () => { throw new Error("isolated lost acknowledgement"); });
    const base = { pool,userId,projectId,eventKey:"parts:1",botId:999,chatId:actorId };
    expect((await deliverTelegramBackgroundCall({...base,partIndex:0,body:{text:"first"},send:sendFirst})).kind).toBe("accepted");
    expect((await deliverTelegramBackgroundCall({...base,partIndex:1,body:{text:"second"},send:sendSecond})).kind).toBe("unknown");
    expect((await deliverTelegramBackgroundCall({...base,partIndex:0,body:{text:"first"},send:sendFirst})).kind).toBe("accepted");
    expect((await deliverTelegramBackgroundCall({...base,partIndex:1,body:{text:"second"},send:sendSecond})).kind).toBe("unknown");
    expect((await deliverTelegramBackgroundCall({...base,partIndex:0,body:{text:"changed"},send:sendFirst})).kind).toBe("unknown");
    expect((await deliverTelegramBackgroundCall({...base,chatId:456,partIndex:0,body:{text:"first"},send:sendFirst})).kind).toBe("unknown");
    expect(sendFirst).toHaveBeenCalledOnce(); expect(sendSecond).toHaveBeenCalledOnce();
  });
  it("rechecks current account permission after the delivery claim and before the provider boundary", async () => {
    const send = vi.fn(async () => ({ok:true,result:{message_id:717}}));
    const paused = { query: async (sql: string, params?: unknown[]) => {
      const result = await pool.query(sql,params);
      if (sql.includes("insert into telegram_background_deliveries")) await pool.query("update users set blocked_at=now() where id=$1",[userId]);
      return result;
    } } as typeof pool;
    const notify = workerFunction("notifyUser",notificationDependencies(send,paused));
    expect(await notify(userId,"private canary",undefined,{projectId,eventKey:"block-during-claim:1"})).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect((await pool.query("select send_status from telegram_background_deliveries")).rows[0].send_status).toBe("cancelled");
  });
  it("keeps a digest claim after unknown delivery and excludes it from confirmed counts", async () => {
    await pool.query("insert into bot_notification_preferences(project_id,user_id,daily_digest_enabled,daily_digest_hour,weekly_digest_enabled,last_daily_digest_date) values($1,$2,true,9,false,null) on conflict(project_id,user_id) do update set daily_digest_enabled=true,daily_digest_hour=9,weekly_digest_enabled=false,last_daily_digest_date=null",[projectId,userId]);
    const send=vi.fn(async()=>{throw new Error("isolated lost acknowledgement");});
    const notifyUser=workerFunction("notifyUser",notificationDependencies(send));
    const run=workerFunction("runBotDigests",{pool,notifyUser,console,Temporal:{Now:{zonedDateTimeISO:()=>({hour:9,dayOfWeek:2,toPlainDate:()=>({toString:()=>"2030-01-01"})})}},botToday:async()=>({text:"digest",buttons:undefined}),runBotPostResults:async()=>0});
    expect(await run()).toMatchObject({dailyDelivered:0,weeklyDelivered:0});
    expect(await run()).toMatchObject({dailyDelivered:0,weeklyDelivered:0});
    expect(send).toHaveBeenCalledOnce();
    expect((await pool.query("select last_daily_digest_date::text from bot_notification_preferences where project_id=$1 and user_id=$2",[projectId,userId])).rows[0].last_daily_digest_date).toBe("2030-01-01");
    expect((await pool.query("select send_status from telegram_background_deliveries")).rows[0].send_status).toBe("unknown");
  });
  it("denies blocked linked accounts at the actual worker lookup/project/control boundary and permits unblock", async () => {
    const userByChat = workerFunction("userByChat", { pool });
    const botProject = workerFunction("botProject", { pool });
    expect((await userByChat(actorId)).enabled).toBe(true);
    expect(await botProject(userId, projectId)).not.toBeNull();
    await pool.query("update users set blocked_at=now() where id=$1", [userId]);
    expect((await userByChat(actorId)).enabled).toBe(false);
    expect(await botProject(userId, projectId)).toBeNull();
    const notices: string[] = [];
    const issueProof = vi.fn();
    const tg = vi.fn(async () => { throw new Error("blocked private actor must not call Telegram metadata"); });
    const workerErrors = vi.fn();
    const handleUpdate = workerFunction("handleUpdate", {
      pool, userByChat, botProject, tg, createTelegramChannelProof: issueProof,
      observeTelegramDiscussionUpdate: async () => {}, captureTelegramAudienceComment: async () => ({ captured: false }),
      parseTelegramBotCommand: () => ({ command: "connect", args: "" }), botReplyAction: () => null,
      botMessageInteraction: () => ({}), observeBotInteraction: async () => {},
      tgSend: async (_chat: number, text: string) => { notices.push(text); }, process: { env: {} }, console: { ...console, error: workerErrors },
    });
    await handleUpdate({ update_id: 9911, message: { chat: { id: actorId, type: "private" }, from: { id: actorId }, text: "/connect" } });
    expect(workerErrors).not.toHaveBeenCalled(); expect(tg).not.toHaveBeenCalled();
    expect(notices).toHaveLength(1); expect(notices[0]).toContain("приостановлен");
    expect(issueProof).not.toHaveBeenCalled();
    await pool.query("update users set blocked_at=null where id=$1", [userId]);
    expect((await userByChat(actorId)).enabled).toBe(true);
    expect(await botProject(userId, projectId)).not.toBeNull();
  });
  it("denies fresh proof and pre-block proof consumption until the account is unblocked", async () => {
    const pending = await proof();
    await pool.query("update users set blocked_at=now() where id=$1", [userId]);
    expect((await createTelegramChannelProof(pool, { userId, projectId, source: "telegram" })).state).toBe("access_denied");
    expect((await save(pending.proofId)).state).toBe("access_denied");
    expect((await pool.query("select count(*)::int n from channels")).rows[0].n).toBe(0);
    await pool.query("update users set blocked_at=null where id=$1", [userId]);
    expect((await save(pending.proofId)).state).toBe("connected");
  });
  it("rechecks account block after the provider permission round trip", async () => {
    const checkedProvider = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      const response = await checkedProvider(url, init);
      if (JSON.parse(String(init?.body)).user_id === actorId) await pool.query("update users set blocked_at=now() where id=$1", [userId]);
      return response;
    }));
    mocks.queueAdd.mockClear();
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "access_denied" });
    expect((await pool.query("select count(*)::int n from channels")).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int n from telegram_channel_connection_proofs")).rows[0].n).toBe(0);
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });
  it("does not consume a legacy bot account link while the target account is blocked", async () => {
    const link = await createLegacyBotLink(pool, { userId, projectId });
    await pool.query("update users set blocked_at=now() where id=$1", [userId]);
    expect((await consumeLegacyBotLink(pool, { code: link.code, telegramChatId: actorId })).state).toBe("account_disabled");
    expect((await pool.query("select used_at from bot_links where code=$1", [link.code])).rows[0].used_at).toBeNull();
    await pool.query("update users set blocked_at=null where id=$1", [userId]);
    expect((await consumeLegacyBotLink(pool, { code: link.code, telegramChatId: actorId })).state).toBe("connected");
  });
  it("does not confirm a private-chat account session after an account block", async () => {
    const session = await createBotConnectionSession(pool, { telegramUserId: actorId, telegramChatId: actorId });
    await pool.query("update users set blocked_at=now() where id=$1", [userId]);
    expect((await inspectBotConnectionSession(pool, { token: session.token, userId })).accountEnabled).toBe(false);
    expect((await confirmBotConnectionSession(pool, { token: session.token, userId })).state).toBe("account_disabled");
    await pool.query("update users set blocked_at=null where id=$1", [userId]);
    expect((await confirmBotConnectionSession(pool, { token: session.token, userId })).state).toBe("connected");
  });
  it.each(["active", "disconnected", "unclaimed"])("rejects outsider for %s channel when shared bot is admin", async (state) => {
    if (state !== "unclaimed") await pool.query(
      "insert into channels(project_id,user_id,network,tg_chat_id,status,is_active) values ($1,$2,'tg',$3,$4,$5)",
      [foreignProjectId, foreignUserId, chatId, state, state === "active"],
    );
    provider("member");
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect((await pool.query("select id from channels where project_id = $1", [projectId])).rowCount).toBe(0);
  });
  it("connects a legitimate admin from API through provider, DB and queue", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    const channel = (await pool.query("select project_id,tg_chat_id,is_active from channels")).rows[0];
    expect(Number(channel.project_id)).toBe(projectId);
    expect(Number(channel.tg_chat_id)).toBe(chatId);
    expect(channel.is_active).toBe(true);
    expect(mocks.queueAdd).toHaveBeenCalledWith("discover", expect.objectContaining({ userId, projectId }), expect.anything());
    expect((await pool.query("select used_at from telegram_channel_connection_proofs")).rows[0].used_at).toBeTruthy();
  });
  it("rejects replay even after new pool simulates application restart", async () => {
    const p = await proof();
    expect((await save(p.proofId)).state).toBe("connected");
    const restarted = new pg.Pool({ connectionString: url, ssl: false });
    try {
      expect((await saveVerifiedTelegramChannel(restarted, { userId, projectId, actorId, proofId: p.proofId, chat: { id: chatId } })).state).toBe("proof_invalid");
    } finally { await restarted.end(); }
  });
  it("allows one winner under concurrent consume of the same proof", async () => {
    const p = await proof();
    const results = await Promise.all([save(p.proofId),save(p.proofId)]);
    expect(results.map((r) => r.state).sort()).toEqual(["connected","proof_invalid"]);
    expect((await pool.query("select count(*)::int n from channels")).rows[0].n).toBe(1);
  });
  it("serializes project archive with a channel binding already admitted in its transaction", async () => {
    const p = await proof();
    const archiver = await pool.connect();
    let archiveResult = "not_attempted";
    try {
      await archiver.query("set lock_timeout = '200ms'");
      const pausedPool = { connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: async (sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params);
          if (sql.includes("select member.role")) {
            try {
              await archiver.query("update projects set is_archived=true where id=$1", [projectId]);
              archiveResult = "committed_before_binding";
            } catch (error) {
              if ((error as { code?: string }).code !== "55P03") throw error;
              archiveResult = "waited_for_binding";
            }
          }
          return result;
        } };
      } };
      const bound = await saveVerifiedTelegramChannel(pausedPool as never, { userId, projectId, actorId, proofId: p.proofId, chat: { id: chatId } });
      expect(archiveResult).toBe("waited_for_binding");
      expect(bound.state).toBe("connected");
      await archiver.query("update projects set is_archived=true where id=$1", [projectId]);
      const fresh = await proof();
      expect((await save(fresh.proofId)).state).toBe("access_denied");
      expect((await pool.query("select count(*)::int n from channels")).rows[0].n).toBe(1);
    } finally { archiver.release(); }
  });
  it("retains the global active channel guard across two legitimate projects racing", async () => {
    const first = await proof();
    const other = await createTelegramChannelProof(pool, { userId: foreignUserId, projectId: foreignProjectId, source: "web", chatId });
    if (other.state !== "ready") throw new Error(other.state);
    const results = await Promise.all([
      save(first.proofId),
      saveVerifiedTelegramChannel(pool, { userId: foreignUserId, projectId: foreignProjectId, actorId: 456, proofId: other.proofId, chat: { id: chatId } }),
    ]);
    expect(results.map((r) => r.state).sort()).toEqual(["connected","taken"]);
  });
  it.each(["expired","wrong_chat","wrong_actor","wrong_project","identity_unlinked","membership_revoked","project_archived"])("rejects %s proof", async (change) => {
    const p = await proof();
    const extra: Record<string, unknown> = {};
    if (change === "expired") await pool.query("update telegram_channel_connection_proofs set created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes'");
    if (change === "wrong_chat") extra.chat = { id: chatId - 1 };
    if (change === "wrong_actor") extra.actorId = 456;
    if (change === "wrong_project") extra.projectId = foreignProjectId;
    if (change === "identity_unlinked") await pool.query("update users set tg_chat_id = null where id = $1", [userId]);
    if (change === "membership_revoked") await pool.query("update project_members set status = 'revoked', revoked_at = now() where user_id = $1", [userId]);
    if (change === "project_archived") await pool.query("update projects set is_archived = true where id = $1", [projectId]);
    expect(["proof_invalid","access_denied"]).toContain((await save(p.proofId, extra)).state);
    expect((await pool.query("select count(*)::int n from channels")).rows[0].n).toBe(0);
  });
  it("binds a native Telegram intent to original project and rejects delayed/replayed events", async () => {
    await pool.query("insert into project_members(project_id,user_id,role) values ($1,$2,'owner') on conflict do nothing", [foreignProjectId,userId]);
    const first = await proof("telegram");
    expect((await createTelegramChannelProof(pool, { userId, projectId: foreignProjectId, source: "telegram" })).state).toBe("connection_pending_other_project");
    const pending = await pendingTelegramChannelProof(pool, { actorId, eventDate: Math.floor(Date.now()/1000) });
    expect(Number(pending?.project_id)).toBe(projectId);
    expect(await pendingTelegramChannelProof(pool, { actorId, eventDate: Math.floor(Date.now()/1000)-600 })).toBeNull();
    expect((await save(first.proofId, { eventId: 991 })).state).toBe("connected");
    const next = await proof("telegram");
    expect((await save(next.proofId, { eventId: 991 })).state).toBe("proof_invalid");
  });
});
