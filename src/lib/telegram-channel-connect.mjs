import { normalizeTelegramBotUsername } from "./bot-connection.mjs";

export const TELEGRAM_CHANNEL_ADMIN_RIGHTS = Object.freeze(["post_messages"]);

export function telegramChannelAdminUrl(value) {
  const username = normalizeTelegramBotUsername(value);
  if (!username) return null;
  return `https://t.me/${username}?startchannel&admin=${TELEGRAM_CHANNEL_ADMIN_RIGHTS.join("+")}`;
}

export function telegramChannelMembershipChange(value) {
  const membership = value?.my_chat_member;
  if (membership?.chat?.type !== "channel") return { state: "ignored" };

  const status = String(membership?.new_chat_member?.status || "");
  if (status === "administrator" && membership?.new_chat_member?.can_post_messages !== false) {
    return { state: "ready", membership };
  }
  if (status === "left" || status === "kicked") {
    return { state: "revoked", membership };
  }
  return { state: "permission_lost", membership };
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`${label}_invalid`);
  return id;
}

function telegramChatId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id === 0) throw new TypeError("telegram_chat_id_invalid");
  return id;
}

function optionalTelegramChatId(value) {
  if (value == null) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id !== 0 ? id : null;
}

function channelTitle(value) {
  return String(value || "").replace(/\s+/gu, " ").trim().slice(0, 200) || null;
}

function channelUsername(value) {
  return String(value || "").replace(/^@/u, "").trim().slice(0, 64) || null;
}

/**
 * Persists a channel only after Telegram has proved that the bot can publish there.
 * The selected project and the global one-channel/one-project invariant are rechecked
 * inside the same transaction so a delayed Telegram update cannot cross workspaces.
 */
export async function saveVerifiedTelegramChannel(pool, input) {
  const userId = positiveId(input?.userId, "user_id");
  const projectId = positiveId(input?.projectId, "project_id");
  const chatId = telegramChatId(input?.chat?.id);
  const title = channelTitle(input?.chat?.title);
  const username = channelUsername(input?.chat?.username);
  const discussionChatId = optionalTelegramChatId(input?.chat?.linked_chat_id);
  const requestId = String(input?.requestId || "").trim().slice(0, 200) || null;
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1::bigint)", [chatId]);

    const membership = (
      await client.query(
        `select member.role
           from project_members member
           join projects project on project.id = member.project_id and project.is_archived = false
          where member.project_id = $1 and member.user_id = $2
            and member.status = 'active'
          for update of member`,
        [projectId, userId],
      )
    ).rows[0];
    if (membership?.role !== "owner") {
      await client.query("rollback");
      return { state: "access_denied" };
    }

    const taken = (
      await client.query(
        `select id, project_id
           from channels
          where network = 'tg' and tg_chat_id = $1 and is_active = true
            and project_id <> $2
          order by id limit 1
          for update`,
        [chatId, projectId],
      )
    ).rows[0];
    if (taken) {
      await client.query("rollback");
      return { state: "taken" };
    }

    const existing = (
      await client.query(
        `select id, status, is_active
           from channels
          where project_id = $1 and network = 'tg' and tg_chat_id = $2
          order by is_active desc, id desc
          limit 1 for update`,
        [projectId, chatId],
      )
    ).rows[0];

    let channelId;
    let action;
    let fromStatus = null;
    if (existing) {
      channelId = Number(existing.id);
      fromStatus = String(existing.status || "active");
      action = existing.is_active === true && fromStatus === "active" ? "verified" : "reconnected";
      await client.query(
        `update channels
            set title = $2, handle = $3,
                tg_discussion_chat_id = coalesce($4, tg_discussion_chat_id),
                status = 'active', is_active = true,
                last_auth_error_code = null, last_auth_error_at = null,
                disconnected_at = null, updated_at = now()
          where id = $1 and project_id = $5`,
        [channelId, title, username, discussionChatId, projectId],
      );
    } else {
      action = "connected";
      const inserted = await client.query(
        `insert into channels
           (project_id, user_id, network, tg_chat_id, title, handle, tg_discussion_chat_id)
         values ($1, $2, 'tg', $3, $4, $5, $6)
         returning id`,
        [projectId, userId, chatId, title, username, discussionChatId],
      );
      channelId = Number(inserted.rows[0].id);
    }

    await client.query(
      `insert into channel_events
         (channel_id, actor_user_id, action, from_status, to_status, request_id)
       values ($1, $2, $3, $4, 'active', $5)
       on conflict (channel_id, request_id) where request_id is not null do nothing`,
      [channelId, userId, action, fromStatus, requestId],
    );
    await client.query("commit");
    return {
      state: action === "verified" ? "already_connected" : action,
      channelId,
      projectId,
      title,
      username,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error?.code === "23505") return { state: "taken" };
    throw error;
  } finally {
    client.release();
  }
}

export async function markTelegramChannelUnavailable(pool, input) {
  const chatId = telegramChatId(input?.chatId);
  const status = input?.status === "revoked" ? "revoked" : "permission_lost";
  const errorCode = status === "revoked"
    ? "telegram_bot_removed"
    : "telegram_publish_permission_lost";
  const actorUserId = input?.actorUserId == null ? null : positiveId(input.actorUserId, "actor_user_id");
  const requestId = String(input?.requestId || "").trim().slice(0, 200) || null;
  const client = await pool.connect();

  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1::bigint)", [chatId]);
    const channel = (
      await client.query(
        `select id, project_id, status
           from channels
          where network = 'tg' and tg_chat_id = $1 and is_active = true
          order by id limit 1 for update`,
        [chatId],
      )
    ).rows[0];
    if (!channel) {
      await client.query("rollback");
      return { state: "not_connected" };
    }

    await client.query(
      `update channels
          set status = $2, is_active = false,
              last_auth_error_code = $3, last_auth_error_at = now(),
              disconnected_at = null, updated_at = now()
        where id = $1`,
      [channel.id, status, errorCode],
    );
    await client.query(
      `insert into channel_events
         (channel_id, actor_user_id, action, from_status, to_status, safe_error_code, request_id)
       values ($1, $2, 'telegram_membership_changed', $3, $4, $5, $6)
       on conflict (channel_id, request_id) where request_id is not null do nothing`,
      [channel.id, actorUserId, channel.status, status, errorCode, requestId],
    );
    await client.query("commit");
    return {
      state: status,
      channelId: Number(channel.id),
      projectId: Number(channel.project_id),
      errorCode,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
