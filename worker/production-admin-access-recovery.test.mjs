import { describe, expect, it, vi } from 'vitest';
import { createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { issueAdminRecovery, recoveryInput } from '../scripts/production-admin-access-recovery.mjs';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const payload = { tokenHash: 'a'.repeat(64), operationId: '11aa22bb-1234-4234-a234-123456789abc', userId: 0, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
const env = { AURORA_ADMIN_USER_IDS: '1', APP_URL: 'https://aurora.example.test' };

function harness({ users = [{ id: '1', email: 'owner@example.test', blocked_at: null, password_reset_generation: '0' }], previous = null, auditFailure = false } = {}) {
  const query = vi.fn(async (sql) => {
    if (sql.includes('from users\n')) return { rows: users };
    if (sql.includes('from bot_admin_action_events a')) return { rows: previous ? [previous] : [] };
    if (sql.startsWith('insert into password_reset_tokens')) return { rows: [{ id: '42', expires_at: '2026-09-06T12:30:00Z' }] };
    if (auditFailure && sql.startsWith('insert into bot_admin_action_events')) throw new Error('private database error');
    return { rows: [] };
  });
  const release = vi.fn();
  return { pool: { connect: async () => ({ query, release }) }, query, release };
}

function decrypt(sealed) {
  const key = privateDecrypt({ key: pair.privateKey, oaepHash: 'sha256' }, Buffer.from(sealed.key, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString());
}

describe('operator recovery retains normal password reset and existing admin boundaries', () => {
  it('issues a generation-bound token, records the operation and encrypts account metadata', async () => {
    const h = harness();
    const sealed = await issueAdminRecovery(h.pool, payload, env);
    expect(decrypt(sealed)).toMatchObject({ email: 'owner@example.test', userId: 1, operationId: payload.operationId });
    expect(JSON.stringify(sealed)).not.toContain('owner@example.test');
    expect(JSON.stringify(sealed)).not.toContain(payload.tokenHash);
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining('id = any($1::bigint[])'), [[1], [], 0]);
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining('insert into password_reset_tokens'), ['1', payload.tokenHash, '1']);
    expect(h.query).toHaveBeenCalledWith('commit');
    expect(h.query.mock.calls.some(([sql]) => sql.includes('password_hash') || sql.includes('delete from sessions'))).toBe(false);
    expect(h.release).toHaveBeenCalledOnce();
  });
  it.each([
    ['recovery_admin_not_found', { users: [] }],
    ['recovery_admin_ambiguous', { users: [{ id: '1' }, { id: '2' }] }],
    ['recovery_admin_blocked', { users: [{ id: '1', blocked_at: new Date() }] }],
  ])('rejects %s without issuing any token', async (code, fixture) => {
    const h = harness(fixture);
    await expect(issueAdminRecovery(h.pool, payload, env)).rejects.toThrow(code);
    expect(h.query).toHaveBeenCalledWith('rollback');
    expect(h.query.mock.calls.some(([sql]) => sql.startsWith('update ') || sql.startsWith('insert '))).toBe(false);
  });
  it('returns the same operation without issuing another token when the response was lost', async () => {
    const h = harness({ previous: { user_id: '1', token_hash: payload.tokenHash, used_at: null, usable: true, expires_at: '2026-09-06T12:30:00Z' } });
    expect(decrypt(await issueAdminRecovery(h.pool, payload, env)).userId).toBe(1);
    expect(h.query.mock.calls.some(([sql]) => sql.startsWith('update ') || sql.startsWith('insert '))).toBe(false);
  });
  it('cannot replay an already consumed or superseded operation', async () => {
    const h = harness({ previous: { user_id: '1', token_hash: payload.tokenHash, used_at: null, usable: false } });
    await expect(issueAdminRecovery(h.pool, payload, env)).rejects.toThrow('recovery_operation_used');
  });
  it('rolls back issuance if recording the audit fails', async () => {
    const h = harness({ auditFailure: true });
    await expect(issueAdminRecovery(h.pool, payload, env)).rejects.toThrow();
    expect(h.query).toHaveBeenCalledWith('rollback');
    expect(h.query).not.toHaveBeenCalledWith('commit');
  });
  it('rejects an invalid key, token hash or insecure origin before database access', () => {
    expect(() => recoveryInput({ ...payload, publicKey: 'invalid' }, env)).toThrow('recovery_key_invalid');
    expect(() => recoveryInput({ ...payload, tokenHash: 'invalid' }, env)).toThrow('recovery_payload_invalid');
    expect(() => recoveryInput(payload, { ...env, APP_URL: 'http://example.test' })).toThrow('recovery_origin_invalid');
  });
});
