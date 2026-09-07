import { afterAll, beforeAll, expect, test } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { migrate } from '../../scripts/migrate.mjs';
import { hasAuroraAdminAccess } from '../lib/admin-access';
import { issueAdminRecovery } from '../../scripts/production-admin-access-recovery.mjs';
import { hashPassword, verifyPassword } from '../lib/password';
import { consumePasswordReset } from '../lib/password-reset';

const url = new URL(process.env.ADMIN_RECOVERY_TEST_DATABASE_URL || 'postgresql://invalid/invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !['/aurora_admin_access_recovery_test', '/aurora_q03_admin_recovery_test'].includes(url.pathname)) throw new Error('isolated_recovery_database_required');
const pool = new pg.Pool({ connectionString: url.href, max: 3 });
let userId: number;
let initialEpoch: number;
const token = randomBytes(32).toString('base64url');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const payload = { operationId: randomUUID(), tokenHash: createHash('sha256').update(token).digest('hex'), userId: 0, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
let env: NodeJS.ProcessEnv;
const extraUsers: number[] = [];

beforeAll(async () => {
  expect(Number((await pool.query("select count(*) from pg_tables where schemaname='public'")).rows[0].count)).toBe(0);
  await pool.query(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  await migrate({ env: { DATABASE_URL: url.href }, logger: { log() {} } });
  const row = (await pool.query(`insert into users(email, name, password_hash) values($1, 'Recovery integration fixture', $2) returning id, credential_epoch`, [`recovery-${randomUUID()}@aurora.test`, await hashPassword('Initial-fixture-password-123!')])).rows[0];
  userId = Number(row.id);
  initialEpoch = Number(row.credential_epoch);
  env = { NODE_ENV: 'test', APP_URL: 'https://aurora.example.test', AURORA_ADMIN_USER_IDS: String(userId) };
});
afterAll(async () => {
  if (userId) {
    await pool.query('delete from bot_admin_action_events where target_id = $1 and action = $2', [userId, 'operator.admin_password_recovery_issued']);
    await pool.query('delete from users where id = $1', [userId]);
  }
  for (const id of extraUsers) {
    await pool.query('delete from bot_admin_action_events where target_id=$1', [id]);
    await pool.query('delete from users where id=$1', [id]);
  }
  await pool.end();
});

test('existing allowlist and normal one-use reset preserve credential and session invariants', async () => {
  await expect(issueAdminRecovery(pool, { ...payload, userId }, { ...env, AURORA_ADMIN_USER_IDS: '0' })).rejects.toThrow('recovery_admin_not_found');
  const [first, retry] = await Promise.all([issueAdminRecovery(pool, payload, env), issueAdminRecovery(pool, payload, env)]);
  expect(first.version).toBe(1);
  expect(retry.version).toBe(1);
  const tokens = (await pool.query('select count(*)::int as count from password_reset_tokens where user_id = $1', [userId])).rows[0];
  expect(tokens.count).toBe(1);
  const events = (await pool.query('select count(*)::int as count from bot_admin_action_events where target_id = $1 and action = $2', [userId, 'operator.admin_password_recovery_issued'])).rows[0];
  expect(events.count).toBe(1);
  const sessionHash = createHash('sha256').update(randomBytes(32)).digest('hex');
  await pool.query(`insert into sessions(token, token_hash, user_id, expires_at, credential_epoch) values($1, $1, $2, now() + interval '1 hour', $3)`, [sessionHash, userId, initialEpoch]);
  const password = 'Recovered-fixture-password-456!';
  expect(await consumePasswordReset({ token, password }, pool)).toBe('ok');
  const user = (await pool.query('select password_hash, credential_epoch from users where id = $1', [userId])).rows[0];
  expect(await verifyPassword(password, user.password_hash)).toBe(true);
  expect(Number(user.credential_epoch)).toBe(initialEpoch + 1);
  expect((await pool.query('select count(*)::int as count from sessions where user_id = $1', [userId])).rows[0].count).toBe(0);
  expect(await consumePasswordReset({ token, password }, pool)).toBe('used');
  await expect(issueAdminRecovery(pool, payload, env)).rejects.toThrow('recovery_operation_used');
});

async function emailFixture(verified: boolean, blocked = false) {
  const email = `recovery-email-${randomUUID()}@example.test`;
  const id = Number((await pool.query(`insert into users(email,name,verified_email,blocked_at)
    values($1,'Synthetic email recovery',$2,$3) returning id`, [email, verified ? email : null, blocked ? new Date() : null])).rows[0].id);
  extraUsers.push(id);
  return { id, email, env: { APP_URL: env.APP_URL, AURORA_ADMIN_EMAILS: email.toUpperCase() } };
}
async function recoveryState(id: number) {
  return (await pool.query(`select password_reset_generation::text as generation,
    (select count(*)::int from password_reset_tokens where user_id=$1) as tokens,
    (select count(*)::int from bot_admin_action_events where target_id=$1) as events
    from users where id=$1`, [id])).rows[0];
}

test('unverified email-only allowlist cannot create an administrator through reset issuance', async () => {
  const actor = await emailFixture(false);
  expect(hasAuroraAdminAccess({ id: actor.id, email: actor.email, email_verified: false }, actor.env)).toBe(false);
  const before = await recoveryState(actor.id);
  const outcome = await issueAdminRecovery(pool, { ...payload, operationId: randomUUID(), tokenHash: randomBytes(32).toString('hex'), userId: actor.id }, actor.env).then(() => 'issued', (error: Error) => error.message);
  // Assert every mutation independently even when the operation incorrectly issued a token.
  expect.soft(await recoveryState(actor.id)).toEqual(before);
  expect(outcome).toBe('recovery_admin_not_found');
});

test('verified email-only allowlist remains eligible and blocked accounts remain refused', async () => {
  const actor = await emailFixture(true);
  expect(hasAuroraAdminAccess({ id: actor.id, email: actor.email, email_verified: true }, actor.env)).toBe(true);
  await issueAdminRecovery(pool, { ...payload, operationId: randomUUID(), tokenHash: randomBytes(32).toString('hex'), userId: actor.id }, actor.env);
  expect(await recoveryState(actor.id)).toEqual({ generation: '1', tokens: 1, events: 1 });
  const blocked = await emailFixture(true, true);
  const before = await recoveryState(blocked.id);
  await expect(issueAdminRecovery(pool, { ...payload, operationId: randomUUID(), userId: blocked.id }, blocked.env)).rejects.toThrow('recovery_admin_blocked');
  expect(await recoveryState(blocked.id)).toEqual(before);
});

test('email changed since verification cannot become an email-only administrator', async () => {
  const actor = await emailFixture(true);
  await pool.query("update users set verified_email='previous@example.test' where id=$1", [actor.id]);
  const before = await recoveryState(actor.id);
  await expect(issueAdminRecovery(pool, { ...payload, operationId: randomUUID(), tokenHash: randomBytes(32).toString('hex'), userId: actor.id }, actor.env)).rejects.toThrow('recovery_admin_not_found');
  expect(await recoveryState(actor.id)).toEqual(before);
});


test('actual token and generation writes roll back when audit persistence fails', async () => {
  const actor = await emailFixture(true);
  const before = await recoveryState(actor.id);
  const failingPool = { connect: async () => {
    const client = await pool.connect();
    return { query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('insert into bot_admin_action_events')) throw new Error('synthetic_audit_failure');
      return client.query(sql, values);
    }, release: () => client.release() };
  } };
  await expect(issueAdminRecovery(failingPool, { ...payload, operationId: randomUUID(), tokenHash: randomBytes(32).toString('hex'), userId: actor.id }, actor.env)).rejects.toThrow('synthetic_audit_failure');
  expect(await recoveryState(actor.id)).toEqual(before);
});

test('operation mismatch and later issuance never revive a superseded token', async () => {
  const actor = await emailFixture(true);
  const first = { ...payload, operationId: randomUUID(), tokenHash: randomBytes(32).toString('hex'), userId: actor.id };
  await issueAdminRecovery(pool, first, actor.env);
  await expect(issueAdminRecovery(pool, { ...first, tokenHash: randomBytes(32).toString('hex') }, actor.env)).rejects.toThrow('recovery_operation_mismatch');
  expect(await recoveryState(actor.id)).toEqual({ generation: '1', tokens: 1, events: 1 });
  await issueAdminRecovery(pool, { ...first, operationId: randomUUID(), tokenHash: randomBytes(32).toString('hex') }, actor.env);
  await expect(issueAdminRecovery(pool, first, actor.env)).rejects.toThrow('recovery_operation_used');
  expect(await recoveryState(actor.id)).toEqual({ generation: '2', tokens: 2, events: 2 });
  expect((await pool.query('select count(*)::int as count from password_reset_tokens where user_id=$1 and used_at is null', [actor.id])).rows[0].count).toBe(1);
});
