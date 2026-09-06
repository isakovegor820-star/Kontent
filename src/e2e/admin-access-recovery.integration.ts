import { afterAll, beforeAll, expect, test } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { issueAdminRecovery } from '../../scripts/production-admin-access-recovery.mjs';
import { hashPassword, verifyPassword } from '../lib/password';
import { consumePasswordReset } from '../lib/password-reset';

const url = new URL(process.env.SYSTEM_TEST_DATABASE_URL || 'postgresql://invalid/invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '57641' || url.pathname !== '/aurora_system_release_test') throw new Error('isolated_recovery_database_required');
const pool = new pg.Pool({ connectionString: url.href, max: 3 });
let userId: number;
let initialEpoch: number;
const token = randomBytes(32).toString('base64url');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const payload = { operationId: randomUUID(), tokenHash: createHash('sha256').update(token).digest('hex'), userId: 0, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
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
