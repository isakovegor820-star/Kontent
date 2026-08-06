const CHANNEL_STATUSES = new Set([
  "active",
  "needs_reconnect",
  "permission_lost",
  "revoked",
  "disconnected",
]);

export function safeChannelErrorCode(value, fallback = "provider_auth_failed") {
  const code = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_:-]{1,96}$/u.test(code) ? code : fallback;
}

export function classifyTelegramChannelFailure({ providerErrorCode, reason }) {
  const code = Number(providerErrorCode);
  const message = String(reason || "").toLowerCase();
  if (code === 401) return { status: "revoked", errorCode: "telegram_bot_token_revoked" };
  if (code === 403 && /kicked|blocked|deactivated|chat not found/iu.test(message)) {
    return { status: "revoked", errorCode: "telegram_bot_removed" };
  }
  if (code === 403 || /not enough rights|chat_admin_required|not an administrator/iu.test(message)) {
    return { status: "permission_lost", errorCode: "telegram_publish_permission_lost" };
  }
  return null;
}

export function classifyVkChannelFailure(result) {
  if (result?.outcome !== "auth_failed") return null;
  const code = safeChannelErrorCode(result.code || result.errorCode, "vk_auth_failed");
  return code.startsWith("vk_permission_")
    ? { status: "permission_lost", errorCode: code }
    : { status: "revoked", errorCode: code };
}

export function classifyOAuthChannelFailure(result) {
  return result?.outcome === "auth_failed"
    ? {
        status: "needs_reconnect",
        errorCode: safeChannelErrorCode(result.code || result.errorCode, "oauth_refresh_failed"),
      }
    : null;
}

export async function transitionChannelHealth(pool, input) {
  if (!CHANNEL_STATUSES.has(input.status)) throw new TypeError("channel_status_invalid");
  const channelId = Number(input.channelId);
  if (!Number.isSafeInteger(channelId) || channelId <= 0) throw new TypeError("channel_id_invalid");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const current = (await client.query(
      `select id, user_id, status from channels
        where id = $1 and ($2::bigint is null or user_id = $2)
        for update`,
      [channelId, input.userId == null ? null : Number(input.userId)],
    )).rows[0];
    if (!current) {
      await client.query("rollback");
      return null;
    }
    const errorCode = input.status === "active"
      ? null
      : safeChannelErrorCode(input.errorCode, "provider_auth_failed");
    await client.query(
      `update channels
          set status = $2,
              is_active = ($2 = 'active'),
              last_auth_error_code = $3,
              last_auth_error_at = case when $3 is null then null else now() end,
              disconnected_at = case when $2 = 'disconnected' then now() else null end,
              updated_at = now()
        where id = $1`,
      [channelId, input.status, errorCode],
    );
    if (current.status !== input.status || errorCode) {
      await client.query(
        `insert into channel_events
           (channel_id, actor_user_id, action, from_status, to_status, safe_error_code, request_id)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          channelId,
          input.actorUserId == null ? null : Number(input.actorUserId),
          input.action || "health_transition",
          current.status,
          input.status,
          errorCode,
          input.requestId || null,
        ],
      );
    }
    await client.query("commit");
    return { channelId, fromStatus: current.status, status: input.status, errorCode };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
