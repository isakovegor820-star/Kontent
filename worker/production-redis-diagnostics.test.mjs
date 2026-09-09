import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const temp = [];
afterEach(() => { for (const p of temp.splice(0)) rmSync(p, { recursive: true, force: true }); });
const source = readFileSync(new URL('../scripts/production-autopilot-diagnostics.sh', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('section "REDIS AUTOPILOT QUEUE STATE"'), source.indexOf('section "WEB READINESS'));

function run({ clients = 'id=1 name=bull:YXV0b3BpbG90LXBsYW5z db=2\nid=2 name=bull:YXV0b3BpbG90LXBsYW5z db=3', keys = 'bull:autopilot-plans:a\nbull:autopilot-plans:a\nbull:autopilot-plans:b', failScan = false, failClients = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurora-diag-test-'));
  temp.push(dir);
  writeFileSync(join(dir, '.env.production'), 'REDIS_URL=redis://127.0.0.1:1/2\n', { mode: 0o600 });
  const stub = `
    section() { :; }; redact() { cat; }
    redis-cli() {
      case "$*" in
        *--count*) return 2;;
        *"client list"*) if [[ "$FAIL_CLIENTS" == 1 ]]; then return 1; fi; printf '%s\\n' "$CLIENTS";;
        *--scan*) if [[ "$FAIL_SCAN" == 1 ]]; then return 1; fi; printf '%s\\n' "$KEYS";;
        *ping*) echo PONG;;
        *zrange*) :;;
        *) echo 0;;
      esac
    }
  `;
  const result = spawnSync('bash', ['-c', `set -Eeuo pipefail\n${stub}\n${section}`], {
    env: { ...process.env, current_path: dir, CLIENTS: clients, KEYS: keys, FAIL_SCAN: failScan ? '1' : '0', FAIL_CLIENTS: failClients ? '1' : '0' },
    encoding: 'utf8', timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('production Redis diagnostics execute the shipped shell section', () => {
  it('counts unique matching keys and only consumers in the selected Redis database', () => {
    const text = run();
    expect(text).toContain('autopilot_queue_keys=2\n');
    expect(text).toContain('autopilot-plans consumers=1\n');
    expect(text).toContain('publish consumers=0\n');
    expect(text).toContain('registered_bull_consumers=bull:YXV0b3BpbG90LXBsYW5z(1)');
  });
  it('reports an empty successful scan as zero', () => {
    expect(run({ keys: '' })).toContain('autopilot_queue_keys=0\n');
  });
  it('does not convert failed scans into zero keys', () => {
    expect(run({ failScan: true })).toContain('autopilot_queue_keys=unavailable\n');
  });
  it('does not convert client query failure into zero consumers', () => {
    const text = run({ failClients: true });
    expect(text).toContain('autopilot-plans consumers=unavailable\n');
    expect(text).toContain('registered_bull_consumers=unavailable\n');
  });
  it('rejects Redis error replies even when the CLI exits successfully', () => {
    const text = run({ clients: 'NOAUTH Authentication required.', keys: 'ERR scan failed' });
    expect(text).toContain('autopilot_queue_keys=unavailable\n');
    expect(text).toContain('publish consumers=unavailable\n');
  });
  it.each(['id=1 name= db=2\nERR partial output', 'id=1 name=bull:YXV0b3BpbG90LXBsYW5z db=2 db=3', 'id=1 name=bull:YXV0b3BpbG90LXBsYW5z db=2\nid=bad name= db=2'])('rejects malformed complete client inventories: %s', (clients) => {
    expect(run({ clients })).toContain('autopilot-plans consumers=unavailable\n');
  });
  it('does not guess the database for legacy client metadata', () => {
    expect(run({ clients: 'id=1 name=bull:YXV0b3BpbG90LXBsYW5z' })).toContain('autopilot-plans consumers=unavailable\n');
  });
});
