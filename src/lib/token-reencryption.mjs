import {
  decryptToken,
  encryptToken,
  tokenEnvelopeKeyId,
  tokenKeyring,
} from "./token-crypto.mjs";

const SOURCES = [
  {
    name: "channels.vk_token",
    select: `select id, user_id, 'vk'::text as provider, vk_token as envelope
               from channels where vk_token is not null
                and split_part(vk_token, ':', 2) <> $1
              order by id for update skip locked limit $2`,
    update: "update channels set vk_token = $2, updated_at = now() where id = $1 and vk_token = $3",
  },
  {
    name: "oauth_tokens.access_token",
    select: `select id, user_id, provider, access_token as envelope
               from oauth_tokens where split_part(access_token, ':', 2) <> $1
              order by id for update skip locked limit $2`,
    update: "update oauth_tokens set access_token = $2, updated_at = now() where id = $1 and access_token = $3",
  },
  {
    name: "oauth_tokens.refresh_token",
    select: `select id, user_id, provider, refresh_token as envelope
               from oauth_tokens where refresh_token is not null
                and split_part(refresh_token, ':', 2) <> $1
              order by id for update skip locked limit $2`,
    update: "update oauth_tokens set refresh_token = $2, updated_at = now() where id = $1 and refresh_token = $3",
  },
  {
    name: "password_reset_outbox.token_envelope",
    select: `select id, user_id, 'password-reset'::text as provider, token_envelope as envelope
               from password_reset_outbox where split_part(token_envelope, ':', 2) <> $1
              order by id for update skip locked limit $2`,
    update: "update password_reset_outbox set token_envelope = $2, updated_at = now() where id = $1 and token_envelope = $3",
  },
  {
    name: "email_change_outbox.token_envelope",
    select: `select id, user_id, 'email-change'::text as provider, token_envelope as envelope
               from email_change_outbox where split_part(token_envelope, ':', 2) <> $1
              order by id for update skip locked limit $2`,
    update: "update email_change_outbox set token_envelope = $2, updated_at = now() where id = $1 and token_envelope = $3",
  },
  {
    name: "legal_source_connections.token_envelope",
    select: `select id, user_id, 'legal:' || provider_id as provider, token_envelope as envelope
               from legal_source_connections where token_envelope is not null
                and split_part(token_envelope, ':', 2) <> $1
              order by id for update skip locked limit $2`,
    update: "update legal_source_connections set token_envelope = $2, updated_at = now() where id = $1 and token_envelope = $3",
  },
];

export async function tokenEnvelopeKeyReadiness(pool, env = process.env) {
  let available;
  try {
    available = tokenKeyring(env).keys;
  } catch {
    return { state: "not_configured", unknownKeyIds: [] };
  }
  const rows = (await pool.query(
    `select distinct split_part(envelope, ':', 2) as key_id from (
       select vk_token as envelope from channels where vk_token is not null
       union all select access_token from oauth_tokens
       union all select refresh_token from oauth_tokens where refresh_token is not null
       union all select token_envelope from password_reset_outbox
       union all select token_envelope from email_change_outbox
       union all select token_envelope from legal_source_connections where token_envelope is not null
     ) encrypted`,
  )).rows;
  const unknownKeyIds = rows
    .map((row) => String(row.key_id || ""))
    .filter((keyId) => !available.has(keyId))
    .sort();
  return { state: unknownKeyIds.length ? "down" : "up", unknownKeyIds };
}

/** Re-encrypts at most batchSize envelopes under row locks; a failure rolls back the whole batch. */
export async function reencryptTokenBatch({ pool, batchSize = 50 }) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new Error("invalid_token_reencryption_batch_size");
  }
  const { currentKeyId } = tokenKeyring();
  const client = await pool.connect();
  const bySource = {};
  let reencrypted = 0;
  try {
    await client.query("begin");
    for (const source of SOURCES) {
      const remaining = batchSize - reencrypted;
      if (remaining <= 0) break;
      const rows = (await client.query(source.select, [currentKeyId, remaining])).rows;
      for (const row of rows) {
        const oldEnvelope = String(row.envelope);
        if (tokenEnvelopeKeyId(oldEnvelope) === currentKeyId) continue;
        const plaintext = decryptToken(oldEnvelope, { userId: row.user_id, provider: row.provider });
        const nextEnvelope = encryptToken(plaintext, { userId: row.user_id, provider: row.provider });
        const updated = await client.query(source.update, [row.id, nextEnvelope, oldEnvelope]);
        if (updated.rowCount === 1) {
          reencrypted += 1;
          bySource[source.name] = (bySource[source.name] || 0) + 1;
        }
      }
    }
    await client.query("commit");
    return { currentKeyId, reencrypted, bySource };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
