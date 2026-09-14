import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import pg from "pg";
import ts from "typescript";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";
import * as botConnection from "@/lib/bot-connection.mjs";
import { formatBotMenu, formatBotNotificationSettings } from "../../worker/bot-copy.mjs";
import { nextBotDigestHour } from "../../worker/bot-assistant.mjs";

const url = String(process.env.BOT_PERSISTENCE_TEST_DATABASE_URL || "");
const target = new URL(url);
if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname) || target.pathname !== "/aurora_bot_persistence_test") {
  throw new Error("Bot persistence integration requires disposable local aurora_bot_persistence_test");
}
const pool = new pg.Pool({ connectionString: url, max: 6, ssl: false });
let source: ts.SourceFile;
let userId: number;
let otherUserId: number;
let projectId: number;
let otherProjectId: number;
const chatId = 123;

function workerFunction(name: string, dependencies: Record<string, unknown>) {
  const node = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!node) throw new Error(`Missing worker function ${name}`);
  return new Function(...Object.keys(dependencies), `return (${node.getText(source)})`)(...Object.values(dependencies));
}

function bot(database = pool) {
  const dependencies: Record<string, unknown> = {
    pool: database, ...botConnection, formatBotMenu, formatBotNotificationSettings, nextBotDigestHour,
    botSendConnectionOnboarding: vi.fn(), tgSend: vi.fn(), tgSendReplyMenu: vi.fn(),
    botChannelConnectPrompt: vi.fn(async () => null),
    botToday: vi.fn(async () => ({ text: "Сегодня", buttons: [] })),
    COMPETITOR_MECHANIC_ACTION_LABEL: "Создать пост по механике",
  };
  for (const name of ["userByChat", "botProject", "botMenu", "botSendMenu", "botResumeAccount", "handleStart", "botNotificationSettings", "botUpdateNotificationPreference"]) {
    dependencies[name] = workerFunction(name, dependencies);
  }
  return dependencies as typeof dependencies & {
    handleStart: (chat: number, from: { id: number }, code: string | null) => Promise<void>;
    tgSend: ReturnType<typeof vi.fn>;
    tgSendReplyMenu: ReturnType<typeof vi.fn>;
    botSendConnectionOnboarding: ReturnType<typeof vi.fn>;
    botChannelConnectPrompt: ReturnType<typeof vi.fn>;
    botNotificationSettings: (userId: number) => Promise<{ text: string }>;
    botUpdateNotificationPreference: (userId: number, action: string, key: string, projectId: number) => Promise<{ text: string }>;
  };
}

async function snapshot() {
  const [account, preferences, notifications, conversations] = await Promise.all([
    pool.query("select id,tg_chat_id from users order by id"),
    pool.query("select * from user_project_preferences order by user_id"),
    pool.query("select * from bot_notification_preferences order by project_id,user_id"),
    pool.query("select * from bot_conversations order by id"),
  ]);
  return { accounts: account.rows, preferences: preferences.rows, notifications: notifications.rows, conversations: conversations.rows };
}

beforeAll(async () => {
  source = ts.createSourceFile("worker.mjs", await readFile(new URL("../../worker.mjs", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: url }, logger: { log() {} } });
  [userId, otherUserId] = (await pool.query("insert into users(email,tg_chat_id) values ('saved@fixture.test',123),('other@fixture.test',456) returning id")).rows.map((row) => Number(row.id));
  [projectId, otherProjectId] = (await pool.query("insert into projects(name,created_by_user_id) values ('Saved project',$1),('Other project',$2) returning id", [userId, otherUserId])).rows.map((row) => Number(row.id));
  await pool.query("insert into project_members(project_id,user_id,role) values ($1,$2,'owner'),($3,$4,'owner')", [projectId,userId,otherProjectId,otherUserId]);
}, 60_000);

beforeEach(async () => {
  await pool.query("update users set tg_chat_id=null,blocked_at=null");
  await pool.query("update users set tg_chat_id=case when id=$1 then 123 else 456 end", [userId]);
  await pool.query("delete from bot_links");
  await pool.query("delete from bot_connection_sessions");
  await pool.query("delete from bot_admin_action_events");
  await pool.query("delete from bot_conversations");
  await pool.query("delete from bot_user_controls");
  await pool.query("delete from bot_notification_preferences");
  await pool.query("delete from user_project_preferences");
  await pool.query("insert into user_project_preferences(user_id,selected_project_id) values ($1,$2),($3,$4)", [userId,projectId,otherUserId,otherProjectId]);
  await pool.query("insert into bot_notification_preferences(project_id,user_id,publication_success_enabled,daily_digest_enabled,daily_digest_hour,weekly_digest_enabled,post_results_enabled) values ($1,$2,false,false,18,false,false),($3,$4,true,true,9,true,true)", [projectId,userId,otherProjectId,otherUserId]);
  await pool.query("insert into bot_conversations(user_id,project_id,state,token,data) values ($1,$2,'waiting_text','saved-draft-token', '{\"idea\":\"Saved work\"}')", [userId, projectId]);
});
afterAll(async () => { await pool.end(); });

describe("durable Telegram account and settings", () => {
  const newSession = (id = chatId) => botConnection.createBotConnectionSession(pool, { telegramUserId: id, telegramChatId: id });
  const unlink = async (id = userId) => botConnection.disconnectBotAccount(pool, {
    userId: id, expectedConnectionKey: (await botConnection.getBotAccountConnection(pool, id)).connectionKey,
  });

  it("rejects unconfirmed disconnects without changing any saved data", async () => {
    const before = await snapshot();
    expect(await botConnection.disconnectBotAccount(pool, { userId, expectedConnectionKey: null })).toEqual({ state: "confirmation_required" });
    expect(await botConnection.disconnectBotChat(pool, { userId, telegramChatId: chatId, expectedConnectionKey: undefined })).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it("revokes all pending and consumed connection links on explicit unlink while retaining settings", async () => {
    const confirmed = await newSession();
    await botConnection.confirmBotConnectionSession(pool, { userId, token: confirmed.token });
    const pending = await newSession();
    const link = await botConnection.createLegacyBotLink(pool, { userId });
    const before = await snapshot();
    expect(await unlink()).toEqual({ state: "disconnected" });
    const after = await snapshot();
    expect(after.accounts).toEqual(before.accounts.map((row) => Number(row.id) === userId ? { ...row, tg_chat_id: null } : row));
    expect(after.preferences).toEqual(before.preferences);
    expect(after.notifications).toEqual(before.notifications);
    expect(after.conversations).toEqual(before.conversations);
    for (const session of [confirmed, pending]) {
      const state = session === confirmed ? "invalid" : "revoked";
      expect((await botConnection.inspectBotConnectionSession(pool, { userId, token: session.token })).state).toBe(state);
      expect((await botConnection.confirmBotConnectionSession(pool, { userId, token: session.token })).state).toBe(state);
    }
    expect((await botConnection.consumeLegacyBotLink(pool, { code: link.code, telegramChatId: chatId })).state).toBe("invalid");
    expect(await snapshot()).toEqual(after);
    expect((await pool.query("select actor_user_id,action,target_id,safe_data from bot_admin_action_events")).rows).toEqual([
      { actor_user_id: String(userId), action: "bot.chat.disconnected", target_id: String(userId), safe_data: { source: "settings_confirmation" } },
    ]);
  });

  it.each([123, 789])("rejects stale web and Telegram confirmations after reconnecting to chat %s", async (nextChat) => {
    const oldKey = (await botConnection.getBotAccountConnection(pool, userId)).connectionKey;
    expect(await unlink()).toEqual({ state: "disconnected" });
    const session = await newSession(nextChat);
    expect((await botConnection.confirmBotConnectionSession(pool, { userId, token: session.token })).state).toBe("connected");
    expect((await botConnection.getBotAccountConnection(pool, userId)).connectionKey).not.toBe(oldKey);
    const before = await snapshot();
    expect(await botConnection.disconnectBotAccount(pool, { userId, expectedConnectionKey: oldKey })).toEqual({ state: "connection_changed" });
    expect(await botConnection.disconnectBotChat(pool, { userId, telegramChatId: nextChat, expectedConnectionKey: oldKey })).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it("does not mistake a historical confirmation for a currently connected account", async () => {
    const session = await newSession();
    await botConnection.confirmBotConnectionSession(pool, { userId, token: session.token });
    expect((await botConnection.confirmBotConnectionSession(pool, { userId, token: session.token })).state).toBe("already_confirmed");
    // Also covers old releases/manual recovery that did not revoke used tokens.
    await pool.query("update users set tg_chat_id=null where id=$1", [userId]);
    expect((await botConnection.inspectBotConnectionSession(pool, { userId, token: session.token })).state).toBe("revoked");
    expect((await botConnection.confirmBotConnectionSession(pool, { userId, token: session.token })).state).toBe("revoked");
  });

  it("serializes simultaneous disconnect requests and journals the change once", async () => {
    const connectionKey = (await botConnection.getBotAccountConnection(pool, userId)).connectionKey;
    const results = await Promise.all(Array.from({ length: 4 }, () => botConnection.disconnectBotAccount(pool, { userId, expectedConnectionKey: connectionKey })));
    expect(results.map((row) => row.state).sort()).toEqual(["already_disconnected", "already_disconnected", "already_disconnected", "disconnected"]);
    expect((await pool.query("select count(*)::int as n from bot_admin_action_events")).rows[0].n).toBe(1);
  });

  it("serializes opposite account transfers without deadlock or replaying the displaced session", async () => {
    const first = await newSession(456);
    const second = await newSession(123);
    const before = await snapshot();
    const results = await Promise.all([
      botConnection.confirmBotConnectionSession(pool, { userId, token: first.token, allowMove: true }),
      botConnection.confirmBotConnectionSession(pool, { userId: otherUserId, token: second.token, allowMove: true }),
    ]);
    expect(results.map((row) => row.state).sort()).toEqual(["connected", "revoked"]);
    const after = await snapshot();
    expect(after.accounts.filter((row) => row.tg_chat_id !== null)).toHaveLength(1);
    expect(after.preferences).toEqual(before.preferences);
    expect(after.notifications).toEqual(before.notifications);
    expect(after.conversations).toEqual(before.conversations);
    expect((await pool.query("select action from bot_admin_action_events order by id")).rows.map((row) => row.action))
      .toEqual(["bot.chat.transferred", "bot.chat.transferred_away"]);
  });

  it("rolls back linkage and token revocation if the change journal cannot be written", async () => {
    const session = await newSession();
    const before = await snapshot();
    await pool.query("create function reject_bot_audit_fixture() returns trigger language plpgsql as $$ begin raise exception 'audit fixture unavailable'; end $$");
    await pool.query("create trigger reject_bot_audit_fixture before insert on bot_admin_action_events for each row execute function reject_bot_audit_fixture()");
    try {
      await expect(unlink()).rejects.toThrow("audit fixture unavailable");
      expect(await snapshot()).toEqual(before);
      expect((await botConnection.inspectBotConnectionSession(pool, { token: session.token, userId })).state).toBe("pending");
    } finally {
      await pool.query("drop trigger reject_bot_audit_fixture on bot_admin_action_events");
      await pool.query("drop function reject_bot_audit_fixture()");
    }
  });

  it("keeps the account, selected project, preferences and draft across repeated starts", async () => {
    const before = await snapshot();
    const h = bot();
    for (let i = 0; i < 3; i += 1) await h.handleStart(chatId, { id: chatId }, null);
    expect(h.tgSendReplyMenu).toHaveBeenCalledTimes(3);
    expect(h.tgSendReplyMenu).toHaveBeenCalledWith(chatId, expect.stringContaining("Saved project"));
    expect(h.botSendConnectionOnboarding).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    expect((await pool.query("select count(*)::int as count from bot_connection_sessions")).rows[0].count).toBe(0);
  });

  it("resumes the actual worker menu from a fresh Node process and database connection", async () => {
    const before = await snapshot();
    const script = `
      import pg from 'pg';
      import { formatBotMenu } from './worker/bot-copy.mjs';
      const pool = new pg.Pool({connectionString: process.env.BOT_PERSISTENCE_TEST_DATABASE_URL, ssl:false});
      const sent = [];
      const tgSendReplyMenu = async (chat, text) => sent.push({chat,text});
      const tgSend = async () => { throw new Error('Unexpected access denial'); };
      const botSendConnectionOnboarding = async () => { throw new Error('Account forgotten after restart'); };
      ${["userByChat", "botProject", "botMenu", "botSendMenu", "botResumeAccount", "handleStart"].map((name) => {
        const node = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
        return node!.getText(source);
      }).join("\n")}
      try { await handleStart(123,{id:123},null); process.stdout.write(JSON.stringify(sent)); }
      finally { await pool.end(); }
    `;
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env: { NODE_ENV: "test", PATH: process.env.PATH, PGUSER: process.env.PGUSER || process.env.USER, BOT_PERSISTENCE_TEST_DATABASE_URL: url } });
    expect(JSON.parse(result.stdout)).toEqual([{ chat: 123, text: expect.stringContaining("Saved project") }]);
    expect(await snapshot()).toEqual(before);
  });

  it("retains settings changed through the actual bot commands after reopening the bot", async () => {
    const h = bot();
    const foreignBefore = (await snapshot()).notifications.filter((row) => Number(row.user_id) === otherUserId);
    await h.botUpdateNotificationPreference(userId, "toggle", "success", projectId);
    await h.botUpdateNotificationPreference(userId, "hour", "next", projectId);
    const before = await snapshot();
    const preference = before.notifications.find((row) => Number(row.user_id) === userId);
    expect(preference).toMatchObject({ publication_success_enabled: true, daily_digest_hour: 8, daily_digest_enabled: false });
    const restarted = bot();
    await restarted.handleStart(chatId, { id: chatId }, null);
    await restarted.botNotificationSettings(userId);
    expect(await snapshot()).toEqual(before);
    expect(before.notifications.filter((row) => Number(row.user_id) === otherUserId)).toEqual(foreignBefore);
  });

  it.each(["used", "expired", "removed"])("resumes without resetting saved state when a settings link is %s", async (state) => {
    const link = await botConnection.createLegacyBotLink(pool, { userId });
    if (state === "used") expect((await botConnection.consumeLegacyBotLink(pool, { code: link.code, telegramChatId: chatId })).state).toBe("connected");
    if (state === "expired") await pool.query("update bot_links set expires_at=now()-interval '1 second' where code=$1", [link.code]);
    if (state === "removed") await pool.query("delete from bot_links where code=$1", [link.code]);
    const before = await snapshot();
    const h = bot();
    await h.handleStart(chatId, { id: chatId }, `${link.code}_channel`);
    expect(h.tgSendReplyMenu).toHaveBeenCalledWith(chatId, expect.stringContaining("Saved project"));
    expect(h.botChannelConnectPrompt).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("preserves state and issues channel proof only for a fresh explicit channel intent", async () => {
    const link = await botConnection.createLegacyBotLink(pool, { userId });
    const before = await snapshot();
    const h = bot();
    await h.handleStart(chatId, { id: chatId }, `${link.code}_channel`);
    expect(h.botChannelConnectPrompt).toHaveBeenCalledWith(userId, { force: true });
    expect(await snapshot()).toEqual(before);
  });

  it("never silently replaces either account and still permits an explicit confirmed transfer", async () => {
    const link = await botConnection.createLegacyBotLink(pool, { userId: otherUserId });
    const before = await snapshot();
    expect(await botConnection.consumeLegacyBotLink(pool, { code: link.code, telegramChatId: chatId })).toEqual({ state: "move_required" });
    expect(await snapshot()).toEqual(before);
    const session = await botConnection.createBotConnectionSession(pool, { telegramUserId: chatId, telegramChatId: chatId });
    expect((await botConnection.confirmBotConnectionSession(pool, { token: session.token, userId: otherUserId })).state).toBe("move_required");
    expect(await snapshot()).toEqual(before);
    expect((await botConnection.confirmBotConnectionSession(pool, { token: session.token, userId: otherUserId, allowMove: true })).state).toBe("connected");
    const after = await snapshot();
    expect(after.accounts).toEqual([{ id: String(userId), tg_chat_id: null }, { id: String(otherUserId), tg_chat_id: "123" }]);
    expect(after.preferences).toEqual(before.preferences);
    expect(after.notifications).toEqual(before.notifications);
    expect(after.conversations).toEqual(before.conversations);
  });

  it("consumes a link once under concurrent delivery without clearing account preferences", async () => {
    const link = await botConnection.createLegacyBotLink(pool, { userId });
    const before = await snapshot();
    const results = await Promise.all(Array.from({ length: 4 }, () => botConnection.consumeLegacyBotLink(pool, { code: link.code, telegramChatId: chatId })));
    expect(results.map((item) => item.state).sort()).toEqual(["connected", "invalid", "invalid", "invalid"]);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["account", "bot"])("retains saved settings while %s access is disabled", async (kind) => {
    if (kind === "account") await pool.query("update users set blocked_at=now() where id=$1", [userId]);
    else await pool.query("insert into bot_user_controls(user_id,enabled) values ($1,false)", [userId]);
    const before = await snapshot();
    const h = bot();
    await h.handleStart(chatId, { id: chatId }, null);
    expect(h.tgSend).toHaveBeenCalledWith(chatId, expect.stringContaining("приостановлен"));
    expect(h.tgSendReplyMenu).not.toHaveBeenCalled();
    expect(h.botSendConnectionOnboarding).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("asks for a project without treating a missing selection as a lost account", async () => {
    await pool.query("delete from user_project_preferences where user_id=$1", [userId]);
    const before = await snapshot();
    const h = bot();
    await h.handleStart(chatId, { id: chatId }, null);
    expect(h.tgSendReplyMenu).toHaveBeenCalledWith(chatId, expect.stringContaining("/projects"));
    expect(h.botSendConnectionOnboarding).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });
});
