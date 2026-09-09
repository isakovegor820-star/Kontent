import type { Pool } from "pg";
import { requireProjectPermission } from "./project-permissions";
import { encryptToken } from "./token-crypto.mjs";
import type { VkGroup } from "./vk";

/**
 * Storage boundary, not credential/permission verification. The legacy HTTP caller
 * is disabled by the release registry. A future verified auth flow must supply its
 * proof before calling this function and before declaring the integration ready.
 */
export async function saveVkChannelConnection(pool: Pool, input: {
  userId: number;
  projectId: number;
  token: string;
  group: VkGroup;
}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await requireProjectPermission(client, input.userId, input.projectId, "project.manage", { lock: true });
    // Serialize same-project creates as well as reconnects, including inactive rows.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`vk-channel:${input.projectId}:${input.group.groupId}`]);
    const existing = (await client.query<{ id: number; user_id: number; status: string }>(
      `select id, user_id, status from channels
        where project_id = $1 and network = 'vk' and vk_group_id = $2 for update`,
      [input.projectId, input.group.groupId],
    )).rows[0];
    // channel.user_id is stable encryption identity, not the reconnecting actor.
    const encrypted = encryptToken(input.token, { userId: existing?.user_id ?? input.userId, provider: "vk" });
    let id = existing?.id;
    if (existing) {
      await client.query(
        `update channels set title = $2, handle = $3, vk_token = $4, updated_at = now()
          where id = $1`,
        [id, input.group.name || null, input.group.screenName || null, encrypted],
      );
    } else {
      id = (await client.query<{ id: number }>(
        `insert into channels (project_id, user_id, network, vk_group_id, vk_token, title, handle,
                               is_active, status, last_auth_error_code)
         values ($1, $2, 'vk', $3, $4, $5, $6, false, 'needs_reconnect', 'vk_auth_flow_unverified') returning id`,
        [input.projectId, input.userId, input.group.groupId, encrypted, input.group.name || null, input.group.screenName || null],
      )).rows[0].id;
    }
    // Persist the audit with the credential. Saving a token alone never marks
    // the channel active or clears an authentication failure.
    await client.query(
      `insert into channel_events (channel_id, actor_user_id, action, from_status, to_status)
       values ($1, $2, 'credential_saved', $3, $4)`,
      [id, input.userId, existing?.status ?? null, existing?.status ?? "needs_reconnect"],
    );
    await client.query("commit");
    return { id: Number(id) };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
