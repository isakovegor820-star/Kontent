import { createHash, randomBytes } from "node:crypto";

export const BOT_CONNECTION_TOKEN_BYTES = 32;
export const BOT_CONNECTION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const BOT_CONNECTION_TTL_MINUTES = 15;
export const LEGACY_BOT_LINK_CODE_PATTERN = /^[a-f0-9]{32}$/u;

export function createBotConnectionToken() {
  return randomBytes(BOT_CONNECTION_TOKEN_BYTES).toString("base64url");
}

export function hashBotConnectionToken(rawToken) {
  const token = String(rawToken || "").trim();
  if (!BOT_CONNECTION_TOKEN_PATTERN.test(token)) return null;
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function maskBotAccountEmail(value) {
  const email = String(value || "").trim();
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return "аккаунт Авроры";
  const local = email.slice(0, at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${local.length > visible.length ? "***" : ""}${email.slice(at)}`;
}

/** A comparison value for the connection the user actually saw, never a credential. */
export function botConnectionKey(userId, chatId, revision = 0) {
  if (chatId == null) return null;
  return createHash("sha256").update(`bot-chat:${safeUserId(userId)}:${safeTelegramId(chatId, "chatId")}:${revision}`).digest("hex").slice(0, 32);
}

// The durable change journal also distinguishes a reconnection to the same chat.
// Read both values in one PostgreSQL snapshot so stale confirmations stay invalid.
export async function getBotAccountConnection(pool, userId) {
  const row = (await pool.query(
    `select tg_chat_id,
            coalesce((select max(id) from bot_admin_action_events
                       where target_type = 'user' and target_id = users.id
                         and action in ('bot.chat.connected', 'bot.chat.disconnected', 'bot.chat.transferred', 'bot.chat.transferred_away')), 0) as connection_revision
       from users where id = $1`,
    [safeUserId(userId)],
  )).rows[0];
  return { telegramChatId: row?.tg_chat_id == null ? null : Number(row.tg_chat_id),
    connectionKey: botConnectionKey(userId, row?.tg_chat_id ?? null, row?.connection_revision ?? 0) };
}

// Connection changes are rare and span two users when a chat moves. A single short
// transaction lock gives connect/confirm/unlink one ordering across web and workers,
// including moves in opposite directions. Normal bot commands do not take this lock.
async function lockBotConnections(client) {
  await client.query("select pg_advisory_xact_lock(hashtextextended('aurora:bot-connections', 0))");
}

async function recordBotConnectionChange(client, { actorUserId, userId, action, source }) {
  await client.query(
    `insert into bot_admin_action_events (actor_user_id, action, target_type, target_id, safe_data)
     values ($1, $2, 'user', $3, $4::jsonb)`,
    [actorUserId, action, userId, JSON.stringify({ source })],
  );
}

async function revokeBotConnectionSessions(client, chatIds, userIds, exceptTokenHash = null) {
  // Used tickets are disposable receipts, not the saved link. Their lifecycle
  // constraint forbids marking them revoked; remove them and retain the audit event.
  await client.query(
    `delete from bot_connection_sessions
      where used_at is not null and (telegram_chat_id = any($1::bigint[]) or confirmed_user_id = any($2::bigint[]))
        and token_hash is distinct from $3`,
    [chatIds, userIds, exceptTokenHash],
  );
  await client.query(
    `update bot_connection_sessions set revoked_at = now()
      where telegram_chat_id = any($1::bigint[]) and used_at is null and revoked_at is null
        and token_hash is distinct from $2`,
    [chatIds, exceptTokenHash],
  );
}

function safeUserId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError("userId must be a positive safe integer");
  }
  return id;
}

export function normalizeTelegramBotUsername(value) {
  const username = String(value || "").replace(/^@/u, "").trim();
  return /^[A-Za-z0-9_]{5,32}$/u.test(username) ? username : null;
}

export function parseLegacyBotStartPayload(value) {
  const match = String(value || "").trim().toLowerCase()
    .match(/^([a-f0-9]{32})(?:_(channel))?$/u);
  if (!match) return { code: String(value || "").trim(), intent: null };
  return { code: match[1], intent: match[2] || null };
}

export async function createLegacyBotLink(pool, input) {
  const userId = safeUserId(input?.userId);
  const code = randomBytes(16).toString("hex");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockBotConnections(client);
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [`legacy_bot_link:user:${userId}`],
    );
    await client.query(
      `delete from bot_links where user_id = $1 and used_at is null`,
      [userId],
    );
    await client.query(
      `insert into bot_links (code, user_id, expires_at)
       values ($1, $2, now() + make_interval(mins => $3))`,
      [code, userId, BOT_CONNECTION_TTL_MINUTES],
    );
    await client.query("commit");
    return { code, expiresInMinutes: BOT_CONNECTION_TTL_MINUTES };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function consumeLegacyBotLink(pool, input) {
  const code = String(input?.code || "").trim().toLowerCase();
  if (!LEGACY_BOT_LINK_CODE_PATTERN.test(code)) return { state: "invalid" };
  const telegramChatId = safeTelegramId(input?.telegramChatId, "telegramChatId");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockBotConnections(client);
    const candidate = (
      await client.query(
        `select user_id from bot_links
          where code = $1 and used_at is null and expires_at > now()`,
        [code],
      )
    ).rows[0];
    if (!candidate) {
      await client.query("rollback");
      return { state: "invalid" };
    }

    const userId = Number(candidate.user_id);
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      [`legacy_bot_link:user:${userId}`],
    );
    const link = (
      await client.query(
        `select user_id from bot_links
          where code = $1 and user_id = $2
            and used_at is null and expires_at > now()
          for update`,
        [code, userId],
      )
    ).rows[0];
    if (!link) {
      await client.query("rollback");
      return { state: "invalid" };
    }
    await client.query("select pg_advisory_xact_lock($1::bigint)", [telegramChatId]);
    const account = (
      await client.query(
        `select app_user.id, app_user.tg_chat_id, (app_user.blocked_at is null and coalesce(control.enabled, true)) as enabled
           from users app_user
           left join bot_user_controls control on control.user_id = app_user.id
          where app_user.id = $1
          for update of app_user`,
        [userId],
      )
    ).rows[0];
    if (!account || account.enabled === false) {
      await client.query("rollback");
      return { state: "account_disabled" };
    }

    const linked = (
      await client.query(
        `select id from users where tg_chat_id = $1 and id <> $2 for update`,
        [telegramChatId, userId],
      )
    ).rows;
    const previousChatId = account.tg_chat_id == null ? null : Number(account.tg_chat_id);
    const moved = linked.length > 0
      || (previousChatId !== null && previousChatId !== telegramChatId);
    // Opening a settings link is not consent to replace an existing account.
    // Transfers use the Telegram-initiated web flow with explicit allowMove.
    if (moved) {
      await client.query("rollback");
      return { state: "move_required" };
    }
    await client.query(
      `update users
          set tg_chat_id = case when id = $1 then $2 else null end
        where id = $1 or tg_chat_id = $2`,
      [userId, telegramChatId],
    );
    await client.query(
      `update bot_links set used_at = now()
        where code = $1 and used_at is null`,
      [code],
    );
    if (previousChatId !== telegramChatId) {
      await recordBotConnectionChange(client, { actorUserId: userId, userId, action: "bot.chat.connected", source: "settings_link" });
    }
    await client.query("commit");
    return { state: "connected", userId, telegramChatId, moved };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function telegramDisplayName(input) {
  const explicit = String(input?.displayName || "").replace(/\s+/gu, " ").trim().slice(0, 200);
  if (explicit) return explicit;
  const username = String(input?.username || "").replace(/^@/u, "").trim().slice(0, 64);
  return username ? `@${username}` : "Этот чат Telegram";
}

function sessionState(row, nowMs = Date.now()) {
  if (!row) return "invalid";
  if (row.revoked_at) return "revoked";
  if (row.used_at) return "confirmed";
  const expiresAt = Date.parse(String(row.expires_at || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return "expired";
  return "pending";
}

function safeTelegramId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return id;
}

export async function createBotConnectionSession(pool, input) {
  const telegramUserId = safeTelegramId(input?.telegramUserId, "telegramUserId");
  const telegramChatId = safeTelegramId(input?.telegramChatId, "telegramChatId");
  const username = String(input?.username || "").replace(/^@/u, "").trim().slice(0, 64) || null;
  const displayName = telegramDisplayName(input);
  const token = createBotConnectionToken();
  const tokenHash = hashBotConnectionToken(token);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockBotConnections(client);
    await client.query("select pg_advisory_xact_lock($1::bigint)", [telegramChatId]);
    await client.query(
      `update bot_connection_sessions
          set revoked_at = now()
        where telegram_chat_id = $1 and used_at is null and revoked_at is null`,
      [telegramChatId],
    );
    const inserted = await client.query(
      `insert into bot_connection_sessions (
         token_hash, telegram_user_id, telegram_chat_id, telegram_username,
         telegram_display_name, expires_at
       ) values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))
       returning expires_at`,
      [
        tokenHash,
        telegramUserId,
        telegramChatId,
        username,
        displayName,
        BOT_CONNECTION_TTL_MINUTES,
      ],
    );
    await client.query("commit");
    return {
      token,
      expiresAt: new Date(inserted.rows[0].expires_at).toISOString(),
      expiresInMinutes: BOT_CONNECTION_TTL_MINUTES,
      telegram: { userId: telegramUserId, chatId: telegramChatId, username, displayName },
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function inspectBotConnectionSession(pool, input) {
  const tokenHash = hashBotConnectionToken(input?.token);
  if (!tokenHash) return { state: "invalid" };
  const row = (
    await pool.query(
      `select token_hash, telegram_user_id, telegram_chat_id, telegram_username,
              telegram_display_name, expires_at, used_at, revoked_at, confirmed_user_id
         from bot_connection_sessions
        where token_hash = $1`,
      [tokenHash],
    )
  ).rows[0];
  let state = sessionState(row, input?.nowMs);
  if (!row) return { state };
  if (state === "confirmed") {
    const current = await pool.query(`select id from users where id = $1 and tg_chat_id = $2`, [row.confirmed_user_id, row.telegram_chat_id]);
    if (!current.rows.length) state = "revoked";
  }

  const result = {
    state,
    telegram: {
      userId: Number(row.telegram_user_id),
      chatId: Number(row.telegram_chat_id),
      username: row.telegram_username || null,
      displayName: telegramDisplayName({
        username: row.telegram_username,
        displayName: row.telegram_display_name,
      }),
    },
    expiresAt: new Date(row.expires_at).toISOString(),
    confirmedByUserId: row.confirmed_user_id == null ? null : Number(row.confirmed_user_id),
    moveRequired: false,
    chatLinkedToAnotherAccount: false,
    accountLinkedToAnotherChat: false,
    accountEnabled: true,
  };

  const userId = Number(input?.userId);
  if (state !== "pending" || !Number.isSafeInteger(userId) || userId <= 0) return result;
  const account = (
    await pool.query(
      `select app_user.tg_chat_id, (app_user.blocked_at is null and coalesce(control.enabled, true)) as enabled,
              exists (
                select 1 from users linked
                 where linked.tg_chat_id = $2 and linked.id <> app_user.id
              ) as chat_linked_to_another_account
         from users app_user
         left join bot_user_controls control on control.user_id = app_user.id
        where app_user.id = $1`,
      [userId, result.telegram.chatId],
    )
  ).rows[0];
  if (!account) return { ...result, accountEnabled: false };
  const accountChatId = account.tg_chat_id == null ? null : Number(account.tg_chat_id);
  const chatLinkedToAnotherAccount = account.chat_linked_to_another_account === true;
  const accountLinkedToAnotherChat = accountChatId !== null && accountChatId !== result.telegram.chatId;
  return {
    ...result,
    moveRequired: chatLinkedToAnotherAccount || accountLinkedToAnotherChat,
    chatLinkedToAnotherAccount,
    accountLinkedToAnotherChat,
    accountEnabled: account.enabled !== false,
  };
}

export async function confirmBotConnectionSession(pool, input) {
  const tokenHash = hashBotConnectionToken(input?.token);
  const userId = Number(input?.userId);
  if (!tokenHash) return { state: "invalid" };
  if (!Number.isSafeInteger(userId) || userId <= 0) return { state: "unauthorized" };

  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockBotConnections(client);
    const session = (
      await client.query(
        `select token_hash, telegram_user_id, telegram_chat_id, expires_at,
                used_at, revoked_at, confirmed_user_id
           from bot_connection_sessions
          where token_hash = $1
          for update`,
        [tokenHash],
      )
    ).rows[0];
    const state = sessionState(session, input?.nowMs);
    if (state === "confirmed") {
      if (Number(session.confirmed_user_id) !== userId) {
        await client.query("rollback");
        return { state: "used" };
      }
      const current = await client.query(`select id from users where id = $1 and tg_chat_id = $2`, [userId, session.telegram_chat_id]);
      await client.query("rollback");
      return current.rows.length > 0
        ? { state: "already_confirmed", telegramChatId: Number(session.telegram_chat_id) }
        : { state: "revoked" };
    }
    if (state !== "pending") {
      await client.query("rollback");
      return { state };
    }

    const telegramChatId = Number(session.telegram_chat_id);
    await client.query("select pg_advisory_xact_lock($1::bigint)", [telegramChatId]);
    const account = (
      await client.query(
        `select app_user.id, app_user.tg_chat_id, (app_user.blocked_at is null and coalesce(control.enabled, true)) as enabled
           from users app_user
           left join bot_user_controls control on control.user_id = app_user.id
          where app_user.id = $1
          for update of app_user`,
        [userId],
      )
    ).rows[0];
    if (!account || account.enabled === false) {
      await client.query("rollback");
      return { state: "account_disabled" };
    }
    const linked = (
      await client.query(
        `select id from users where tg_chat_id = $1 and id <> $2 for update`,
        [telegramChatId, userId],
      )
    ).rows;
    const accountChatId = account.tg_chat_id == null ? null : Number(account.tg_chat_id);
    const chatLinkedToAnotherAccount = linked.length > 0;
    const accountLinkedToAnotherChat = accountChatId !== null && accountChatId !== telegramChatId;
    const moveRequired = chatLinkedToAnotherAccount || accountLinkedToAnotherChat;
    if (moveRequired && input?.allowMove !== true) {
      await client.query("rollback");
      return {
        state: "move_required",
        chatLinkedToAnotherAccount,
        accountLinkedToAnotherChat,
      };
    }

    await client.query(
      `update users
          set tg_chat_id = case when id = $1 then $2 else null end
        where id = $1 or tg_chat_id = $2`,
      [userId, telegramChatId],
    );
    await client.query(
      `update bot_connection_sessions
          set used_at = now(), confirmed_user_id = $2
        where token_hash = $1 and used_at is null and revoked_at is null`,
      [tokenHash, userId],
    );
    await revokeBotConnectionSessions(client, [telegramChatId, ...(accountChatId == null ? [] : [accountChatId])], [userId, ...linked.map((row) => Number(row.id))], tokenHash);
    // Invalidate pre-transfer links so a forgotten settings tab cannot reconnect a
    // displaced account later without a new request from that account.
    await client.query(`delete from bot_links where user_id = any($1::bigint[]) and used_at is null`, [[userId, ...linked.map((row) => Number(row.id))]]);
    if (accountChatId !== telegramChatId || moveRequired) {
      await recordBotConnectionChange(client, { actorUserId: userId, userId, action: moveRequired ? "bot.chat.transferred" : "bot.chat.connected", source: "web_confirmation" });
      for (const previous of linked) {
        await recordBotConnectionChange(client, { actorUserId: userId, userId: Number(previous.id), action: "bot.chat.transferred_away", source: "web_confirmation" });
      }
    }
    await client.query("commit");
    return {
      state: "connected",
      telegramChatId,
      moved: moveRequired,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function disconnectBotAccount(pool, input) {
  const userId = Number(input?.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return { state: "invalid" };
  if (typeof input?.expectedConnectionKey !== "string" || !/^[a-f0-9]{32}$/u.test(input.expectedConnectionKey)) return { state: "confirmation_required" };
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockBotConnections(client);
    const account = (await client.query(`select tg_chat_id from users where id = $1 for update`, [userId])).rows[0];
    if (!account?.tg_chat_id) {
      await client.query("rollback");
      return { state: "already_disconnected" };
    }
    const telegramChatId = Number(account.tg_chat_id);
    const current = await getBotAccountConnection(client, userId);
    if (current.connectionKey !== input.expectedConnectionKey) {
      await client.query("rollback");
      return { state: "connection_changed" };
    }
    await client.query("select pg_advisory_xact_lock($1::bigint)", [telegramChatId]);
    const disconnected = await client.query(
      `update users set tg_chat_id = null
        where id = $1 and tg_chat_id = $2
        returning id`,
      [userId, telegramChatId],
    );
    if (disconnected.rowCount !== 1) {
      await client.query("rollback");
      return { state: "connection_changed" };
    }
    await revokeBotConnectionSessions(client, [telegramChatId], [userId]);
    await client.query(`delete from bot_links where user_id = $1 and used_at is null`, [userId]);
    await recordBotConnectionChange(client, { actorUserId: userId, userId, action: "bot.chat.disconnected", source: input.source === "telegram" ? "telegram" : "settings_confirmation" });
    await client.query("commit");
    return { state: "disconnected" };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function disconnectBotChat(pool, input) {
  const userId = Number(input?.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const telegramChatId = safeTelegramId(input?.telegramChatId, "telegramChatId");
  const current = await getBotAccountConnection(pool, userId);
  if (current.telegramChatId !== telegramChatId) return false;
  const result = await disconnectBotAccount(pool, { userId, expectedConnectionKey: input?.expectedConnectionKey, source: "telegram" });
  return result.state === "disconnected";
}
