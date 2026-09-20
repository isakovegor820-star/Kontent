// Creates only a fresh disposable database and Redis instance; never consumes existing queues.
// Run from the repository root. Stop with SIGTERM; cleanup targets only resources created here.
import { parseEnv } from 'node:util';
import { readFile, writeFile, mkdtemp, mkdir, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import pg from 'pg';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const localEnv = parseEnv(await readFile('.env.local', 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; }));
const source = new URL(process.env.DATABASE_URL || localEnv.DATABASE_URL);
const reportDir = process.env.AUTOPILOT_QA_REPORT_DIR || 'reports/autopilot-calendar-2026-09-07';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname)) throw new Error('QA requires loopback PostgreSQL');
const name = `aurora_autopilot_qa_${randomBytes(5).toString('hex')}`;
const directory = await mkdtemp(join(tmpdir(), 'aurora-autopilot-qa-'));
const database = new URL(source); database.pathname = `/${name}`;
const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
const admin = new pg.Pool({ connectionString: adminUrl.toString(), ssl: false, max: 1, connectionTimeoutMillis: 3000 });
const children = [];
let created = false;
let stopped = false;
let redis;
async function freePort() { const server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise((r) => server.close(r)); return port; }
function start(label, command, args, env) {
  const child = spawn(command, args, { env, cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const log = createWriteStream(join(directory, `${label}.log`));
  child.stdout.pipe(log); child.stderr.pipe(log);
  return child;
}
async function cleanup() {
  if (stopped) return; stopped = true;
  for (const child of children.reverse()) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  await new Promise((r) => setTimeout(r, 1500));
  for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  redis?.disconnect();
  if (created) await admin.query(`drop database "${name}" with (force)`);
  await admin.end();
  await unlink(join(directory, 'runtime.json')).catch(() => {});
  await unlink(join(reportDir, 'runtime-path.txt')).catch(() => {});
}
process.on('SIGTERM', () => void cleanup().finally(() => process.exit(0)));
process.on('SIGINT', () => void cleanup().finally(() => process.exit(0)));
try {
  await admin.query(`create database "${name}"`); created = true;
  const redisPort = await freePort();
  const webPort = await freePort();
  const fakePort = await freePort();
  const redisUrl = `redis://127.0.0.1:${redisPort}/0`;
  const baseUrl = `http://127.0.0.1:${webPort}`;
  const fakeBase = `http://127.0.0.1:${fakePort}`; // Closed port: providers are unavailable, never live.
  start('redis', '/opt/homebrew/bin/redis-server', ['--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no', '--dir', directory], process.env);
  redis = new IORedis(redisUrl, { maxRetriesPerRequest: null }); redis.on('error', () => {});
  await redis.ping();
  // Set every .env.local key explicitly so Node/Next cannot import live credentials later.
  const env = { ...process.env, ...Object.fromEntries(Object.keys(localEnv).map((key) => [key, ''])),
    NODE_ENV: 'development', NODE_OPTIONS: `--require=${resolve('scripts/autopilot-qa-network-guard.cjs')}`,
    DATABASE_URL: database.toString(), REDIS_URL: redisUrl,
    APP_URL: baseUrl, NEXT_PUBLIC_APP_URL: baseUrl,
    AURORA_SENTRY_DISABLED: '1', NEXT_PUBLIC_AURORA_SENTRY_DISABLED: '1', NEXT_TELEMETRY_DISABLED: '1',
    AURORA_NEXT_DIST_DIR: process.env.AUTOPILOT_QA_DIST_DIR || '.next-autopilot-qa',
    TG_BOT_TOKEN: '9000000000:qa-only-not-live', TG_BOT_USERNAME: 'qa_autopilot_bot', TG_API_URL: fakeBase,
    OPENAI_API_KEY: '', AI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', NAVYAI_API_KEY: '',
    OPENAI_API_URL: `${fakeBase}/v1`, AI_API_URL: `${fakeBase}/v1`, NAVYAI_API_URL: `${fakeBase}/v1`, OLLAMA_URL: fakeBase,
    TOKENS_MASTER_KEY: 'qa-autopilot-isolated-master-key-2026-09-07', TOKENS_KEY_ID: '1',
    TRACKING_ATTRIBUTION_SECRET: 'qa-autopilot-isolated-attribution-secret', TRACKING_FINGERPRINT_SECRET: 'qa-autopilot-isolated-fingerprint-secret',
    TG_WEBHOOK_URL: '', AURORA_ADMIN_EMAILS: 'autopilot-qa@aurora.test',
  };
  start('app', 'npm', ['run', 'dev', '--', '--port', String(webPort), '--hostname', '127.0.0.1'], env);
  const queue = new Queue('autopilot-plans', { connection: redis });
  const deadline = Date.now() + 180000;
  let workers = 0;
  while (Date.now() < deadline) {
    workers = await queue.getWorkersCount();
    if (workers > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!workers) throw new Error(`autopilot-plans has no worker; logs: ${directory}`);
  await queue.close();
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ databaseUrl: database.toString(), redisUrl, baseUrl, directory, processId: process.pid }), { mode: 0o600 });
  await mkdir(reportDir, { recursive: true });
  await writeFile(join(reportDir, 'runtime-path.txt'), directory);
  console.log(JSON.stringify({ ready: true, baseUrl, workers, directory, isolated: true, externalHttpBlocked: true }));
  await new Promise(() => {});
} catch (error) {
  console.error(error.message);
  await cleanup();
  process.exitCode = 1;
}
