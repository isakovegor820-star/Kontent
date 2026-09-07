import { createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ACTION = 'operator.admin_password_recovery_issued';
const knownErrors = new Set(['recovery_payload_invalid', 'recovery_key_invalid', 'recovery_origin_invalid', 'recovery_admin_not_found', 'recovery_admin_ambiguous', 'recovery_admin_blocked', 'recovery_operation_used', 'recovery_operation_mismatch']);

function fail(code) { throw new Error(code); }
function configuredIds(value) { return String(value || '').split(',').map(Number).filter(n => Number.isSafeInteger(n) && n > 0); }
function configuredEmails(value) { return String(value || '').split(',').map(s => s.trim().toLowerCase()).filter(s => s.includes('@') && s.length <= 320); }

export function recoveryInput(payload, env) {
  if (!payload || !/^[a-f0-9]{64}$/.test(payload.tokenHash || '') || !/^[a-f0-9-]{36}$/.test(payload.operationId || '') || !Number.isSafeInteger(payload.userId) || payload.userId < 0) fail('recovery_payload_invalid');
  let key;
  try { key = createPublicKey(payload.publicKey); } catch { fail('recovery_key_invalid'); }
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) fail('recovery_key_invalid');
  let origin;
  try { origin = new URL(env.APP_URL); } catch { fail('recovery_origin_invalid'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password) fail('recovery_origin_invalid');
  return { ...payload, key, origin: origin.origin, ids: configuredIds(env.AURORA_ADMIN_USER_IDS), emails: configuredEmails(env.AURORA_ADMIN_EMAILS) };
}

export function sealRecoveryResult(result, key) {
  const secret = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(result), 'utf8'), cipher.final()]);
  return { version: 1, algorithm: 'RSA-OAEP-SHA256+A256GCM', key: publicEncrypt({ key, oaepHash: 'sha256' }, secret).toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

/** Issue a normal, one-use reset token for an already allowlisted administrator.
 * Only the caller has the random plaintext token and password. No new admin is
 * granted access, no password is changed here, and account details leave encrypted.
 */
export async function issueAdminRecovery(pool, payload, env) {
  const input = recoveryInput(payload, env);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local statement_timeout = '10s'");
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [input.operationId]);
    const candidates = (await client.query(
      `select id, email, blocked_at, password_reset_generation from users
       where (id = any($1::bigint[]) or (email is not null and verified_email = email
              and lower(btrim(email)) = any($2::text[])))
         and ($3::bigint = 0 or id = $3)
       order by id limit 2 for update`, [input.ids, input.emails, input.userId],
    )).rows;
    if (candidates.length === 0) fail('recovery_admin_not_found');
    if (candidates.length !== 1) fail('recovery_admin_ambiguous');
    const user = candidates[0];
    if (user.blocked_at) fail('recovery_admin_blocked');
    const previous = (await client.query(
      `select t.id, t.user_id, t.token_hash, t.used_at, t.expires_at,
              t.expires_at > now() and t.generation = u.password_reset_generation as usable
       from bot_admin_action_events a
       join password_reset_tokens t on t.id = (a.safe_data->>'tokenId')::bigint
       join users u on u.id = t.user_id
       where a.action = $1 and a.safe_data->>'operationId' = $2`, [ACTION, input.operationId],
    )).rows[0];
    let expiresAt;
    if (previous) {
      if (Number(previous.user_id) !== Number(user.id) || previous.token_hash !== input.tokenHash) fail('recovery_operation_mismatch');
      if (previous.used_at || !previous.usable) fail('recovery_operation_used');
      expiresAt = previous.expires_at;
    } else {
      const generation = (BigInt(user.password_reset_generation) + 1n).toString();
      await client.query('update users set password_reset_generation = $2 where id = $1', [user.id, generation]);
      await client.query('update password_reset_tokens set used_at = coalesce(used_at, now()) where user_id = $1 and used_at is null', [user.id]);
      const token = (await client.query(
        `insert into password_reset_tokens (user_id, token_hash, expires_at, generation)
         values ($1, $2, now() + interval '30 minutes', $3) returning id, expires_at`, [user.id, input.tokenHash, generation],
      )).rows[0];
      expiresAt = token.expires_at;
      await client.query(
        `insert into bot_admin_action_events (actor_user_id, action, target_type, target_id, safe_data)
         values (null, $1, 'user', $2, $3::jsonb)`,
        [ACTION, user.id, JSON.stringify({ operationId: input.operationId, tokenId: String(token.id), channel: 'authorized_operator_local_token', runId: String(env.AURORA_RECOVERY_RUN_ID || '') })],
      );
    }
    const sealed = sealRecoveryResult({ userId: Number(user.id), email: user.email, origin: input.origin, expiresAt, operationId: input.operationId }, input.key);
    await client.query('commit');
    return sealed;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool;
  try {
    const { default: pg } = await import('pg');
    const payload = JSON.parse(Buffer.from(String(process.env.AURORA_ADMIN_RECOVERY_PAYLOAD_B64 || ''), 'base64').toString('utf8'));
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000 });
    const sealed = await issueAdminRecovery(pool, payload, process.env);
    process.stdout.write(`${JSON.stringify(sealed)}\n`);
  } catch (error) {
    process.stderr.write(`${knownErrors.has(error?.message) ? error.message : 'admin_recovery_failed'}\n`);
    process.exitCode = 1;
  } finally { await pool?.end().catch(() => {}); }
}
