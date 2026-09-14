import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import pg from 'pg';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const targetDir = process.cwd();
const oldDir = resolve(process.argv[2]);
const reportDir = resolve('reports/trends-dashboard-2026-09-09');
const oldSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: oldDir, encoding: 'utf8' }).trim();
const targetSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetDir, encoding: 'utf8' }).trim();
const targetTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: targetDir, encoding: 'utf8' }).trim();
assert.equal(oldSha, process.argv[3] || '48394c3075cc2c4fe13800d2e031b7cc209b0671');
for (const dir of [targetDir, oldDir]) await readFile(join(dir, dir === targetDir ? '.next-trends-build/BUILD_ID' : '.next/BUILD_ID'), 'utf8');
const work = await mkdtemp(join(tmpdir(), 'aurora-rollback-'));
const suffix = randomUUID().replaceAll('-', '');
const database = `aurora_rollback_qa_${suffix}`;
const restoreDatabase = `aurora_rollback_restore_${suffix}`;
const admin = new pg.Pool({ connectionString: 'postgresql://127.0.0.1/postgres', ssl: false, connectionTimeoutMillis: 15000 });
const databaseUrl = `postgresql://127.0.0.1/${database}`;
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, connectionTimeoutMillis: 15000 });
const oldMigration = await import(pathToFileURL(join(oldDir, 'scripts/migrate.mjs')));
const targetMigration = await import(pathToFileURL(join(targetDir, 'scripts/migrate.mjs')));
const oldSchema = await import(pathToFileURL(join(oldDir, 'src/lib/schema-readiness.mjs')));
const targetSchema = await import(pathToFileURL(join(targetDir, 'src/lib/schema-readiness.mjs')));
const { MEDIA_QUEUE } = await import(pathToFileURL(join(targetDir, 'src/lib/media-generation.mjs')));
const freePort = () => new Promise((resolvePort, reject) => {
  const server = net.createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePort(port)); });
});
const redisPort = await freePort();
const webPort = await freePort();
const redisUrl = `redis://127.0.0.1:${redisPort}`;
const baseUrl = `http://127.0.0.1:${webPort}`;
const browserOrigin = 'https://rollback.example.test';
const readinessToken = randomUUID() + randomUUID();
const runtimeEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || tmpdir(),
  NODE_ENV: 'production', DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, PGUSER: userInfo().username,
  PGSSLMODE: 'disable', AURORA_READINESS_TOKEN: readinessToken,
  AURORA_DB_POOL_MAX_WEB: '4', AURORA_DB_POOL_MAX_WORKER: '8', AURORA_DB_CONNECTION_TIMEOUT_MS: '10000',
  AURORA_AVATAR_BODY_LIMIT_BYTES: String(10 * 1024 * 1024),
  TOKENS_MASTER_KEY: 'synthetic-rollback-key-only', TOKENS_KEY_ID: '1',
  APP_URL: browserOrigin, NEXT_PUBLIC_APP_URL: browserOrigin,
  NAVYAI_API_KEY: '', OPENAI_API_KEY: '', AI_API_KEY: '', TG_BOT_TOKEN: '', TG_CHAT_ID: '',
  NAVYAI_API_URL: 'http://127.0.0.1:9', AI_API_URL: 'http://127.0.0.1:9',
  SENTRY_DSN: '', NEXT_PUBLIC_SENTRY_DSN: '',
};
const children = new Set();
function launch(command, args, cwd, env, label) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(reportDir, `rollback-${label}.log`));
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  child.once('exit', () => { children.delete(child); log.end(); });
  children.add(child); return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    child.kill('SIGTERM');
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout; let error;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch (caught) { error = caught; }
    await sleep(300);
  }
  throw new Error(`Timed out: ${label}: ${error?.message || ''}`);
}
let created = false, restoreCreated = false, redis, redisChild, queues = [];
let userId, projectId, siteId;
const steps = [];
const evidence = { previousSha: oldSha, targetSha, targetTree, startedAt: new Date().toISOString(), scope: 'synthetic local PostgreSQL + isolated Redis; no provider calls or public publications', steps };
async function session(legacy) {
  const raw = randomUUID() + randomUUID();
  const hash = createHash('sha256').update(raw).digest('hex');
  const column = legacy ? 'token' : 'token_hash';
  await pool.query(`insert into sessions (${column},user_id,expires_at,credential_epoch) values ($1,$2,now()+interval '30 days',1)`, [hash,userId]);
  const stored = (await pool.query('select token,token_hash from sessions where token_hash=$1', [hash])).rows[0];
  assert.equal(stored.token, hash); assert.equal(stored.token_hash, hash);
  return `sid=${raw}`;
}
async function request(path, cookie, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { cookie, origin: browserOrigin, 'x-aurora-project-id': String(projectId), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await response.json(); assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(data)}`); return data;
}
async function smoke(label, expectForward) {
  const readyResponse = await fetch(`${baseUrl}/api/readiness`, { headers: { authorization: `Bearer ${readinessToken}` }, signal: AbortSignal.timeout(15000) });
  const ready = await readyResponse.json();
  assert.equal(ready.schemaReady, true, JSON.stringify(ready.reasons));
  assert.equal(ready.databaseReady, true); assert.equal(ready.webReady, true);
  assert.equal(ready.checks.redis, 'up'); assert.equal(ready.checks.publicationWorker, 'up');
  assert.equal(ready.checks.schema.forwardMigrations.length > 0, expectForward);
  for (const legacy of [true, false]) {
    const cookie = await session(legacy);
    const list = await request('/api/sites', cookie);
    assert(list.sites.some((site) => site.id === siteId));
    const detail = await request(`/api/sites/${siteId}`, cookie); assert.equal(detail.site.id, siteId);
  }
  const cookie = await session(false);
  const articleId = Number((await pool.query(`insert into site_articles
    (site_id,project_id,user_id,article_type,origin,source_ref,slug,title,body_markdown,body_html,status,quality)
    values ($1,$2,$3,'company_news','manual','{"kind":"manual"}',$4,'Проверка совместимости','Тестовый материал','<p>Тестовый материал</p>','needs_review','{"issues":[]}') returning id`,
    [siteId,projectId,userId,`rollback-${label}`])).rows[0].id);
  await request(`/api/sites/${siteId}/articles/${articleId}`, cookie);
  const approved = await request(`/api/sites/${siteId}/articles/${articleId}`, cookie, 'POST', { action: 'approve' });
  assert.equal(approved.article.status, 'approved');
  assert.equal((await pool.query('select count(*)::int as n from site_article_publications')).rows[0].n, 0);
  const html = await fetch(`${baseUrl}/app/sites`, { headers: { cookie }, signal: AbortSignal.timeout(15000) });
  assert.equal(html.status, 200);
  const stats = await request('/api/trends/stats?source=collection&period=week', cookie);
  assert(stats.summary);
  if (label === 'target') { assert.equal(stats.summary.posts, 0); assert.equal(stats.series.length, 7); }
  const trendsHtml = await fetch(`${baseUrl}/app/trends`, { headers: { cookie }, signal: AbortSignal.timeout(15000) });
  assert.equal(trendsHtml.status, 200);
  steps.push({ label, authenticatedTrendsStats: true, trendsHtml: 200, schemaReady: true, legacyAndHashedSessionWrites: true, authenticatedSiteRead: true, articleReadAndApproval: true, publicPublications: 0, siteHtml: 200, forwardMigrations: ready.checks.schema.forwardMigrations });
  console.log(`[rollback] ${label}: passed`);
}
async function startRelease(dir, label) {
  const web = launch(process.execPath, [join(dir, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(webPort)], dir, { ...runtimeEnv, AURORA_RUNTIME_ROLE: 'web', ...(dir === targetDir ? { AURORA_NEXT_DIST_DIR: '.next-trends-build' } : {}) }, `${label}-web`);
  const worker = launch(process.execPath, ['worker.mjs'], dir, { ...runtimeEnv, AURORA_RUNTIME_ROLE: 'worker', AURORA_WORKER_MODE: 'full' }, `${label}-worker`);
  await until(async () => {
    assert.equal(worker.exitCode, null, `${label} worker exited`);
    return (await Promise.all(queues.map((queue) => queue.getWorkers()))).every((workers) => workers.length > 0);
  }, `${label} worker registration`);
  await until(async () => (await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) })).status === 200, `${label} web`);
  await until(async () => {
    const response = await fetch(`${baseUrl}/api/readiness`, { headers: { authorization: `Bearer ${readinessToken}` }, signal: AbortSignal.timeout(5000) });
    return (await response.json()).checks?.publicationWorker === 'up';
  }, `${label} heartbeat`);
  return async () => { await stop(web); await stop(worker); };
}
try {
  await admin.query(`create database ${database}`); created = true;
  await pool.query(await readFile(join(oldDir, 'db/schema.sql'), 'utf8'));
  await oldMigration.migrate({ env: { DATABASE_URL: databaseUrl }, directory: join(oldDir, 'db/migrations'), logger: { log() {} } });
  assert.equal((await oldSchema.probeSchemaCompatibility(pool)).ready, true);
  await pool.query("update trend_sources set enabled=false");
  userId = Number((await pool.query("insert into users (email,name,onboarding_completed_at) values ('rollback@example.test','Synthetic rollback',now()) returning id")).rows[0].id);
  projectId = Number((await pool.query("insert into projects (name,created_by_user_id) values ('Synthetic rollback',$1) returning id", [userId])).rows[0].id);
  await pool.query("insert into project_members (project_id,user_id,role) values ($1,$2,'owner')", [projectId,userId]);
  await pool.query('insert into user_project_preferences (user_id,selected_project_id) values ($1,$2)', [userId,projectId]);
  siteId = Number((await pool.query("insert into sites (project_id,user_id,confirmed_domain,canonical_url,verification_token) values ($1,$2,'rollback.example.test','https://rollback.example.test/','synthetic-only-rollback-verification-token') returning id", [projectId,userId])).rows[0].id);
  const backup = join(work, 'baseline.dump');
  execFileSync('/opt/homebrew/opt/postgresql@17/bin/pg_dump', ['-Fc','-f',backup,databaseUrl]);
  await admin.query(`create database ${restoreDatabase}`); restoreCreated = true;
  execFileSync('/opt/homebrew/opt/postgresql@17/bin/pg_restore', ['--no-owner','-d',`postgresql://127.0.0.1/${restoreDatabase}`,backup]);
  const restored = new pg.Pool({ connectionString: `postgresql://127.0.0.1/${restoreDatabase}`, ssl: false });
  try { assert.equal((await oldSchema.probeSchemaCompatibility(restored)).ready, true); assert.equal((await restored.query('select count(*)::int as n from users')).rows[0].n, 1); }
  finally { await restored.end(); }
  await admin.query(`drop database ${restoreDatabase}`); restoreCreated = false;
  steps.push({ label: 'synthetic-backup-restore', passed: true });
  redisChild = launch('/opt/homebrew/bin/redis-server', ['--bind','127.0.0.1','--port',String(redisPort),'--save','','--appendonly','no','--dir',work], targetDir, { PATH: process.env.PATH }, 'redis');
  redis = new IORedis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true, retryStrategy: (n) => n < 20 ? 200 : null });
  await sleep(500);
  await redis.connect();
  queues = ['publish','site-articles',MEDIA_QUEUE,'autopilot-plans'].map((name) => new Queue(name, { connection: redis }));
  let close = await startRelease(oldDir, 'baseline');
  await smoke('baseline', false);
  await targetMigration.migrate({ env: { DATABASE_URL: databaseUrl }, directory: join(targetDir, 'db/migrations'), logger: { log() {} } });
  assert.equal((await targetSchema.probeSchemaCompatibility(pool)).ready, true);
  await smoke('old-on-forward-schema', true);
  await close();
  close = await startRelease(targetDir, 'target');
  await smoke('target', false);
  await close();
  close = await startRelease(oldDir, 'rollback');
  await smoke('rollback-with-forward-schema', true);
  await close();
  evidence.passed = true;
} catch (error) {
  evidence.passed = false; evidence.error = String(error?.stack || error); throw error;
} finally {
  for (const child of [...children]) if (child !== redisChild) await stop(child);
  for (const queue of queues) await queue.close().catch(() => {});
  redis?.disconnect();
  await stop(redisChild);
  await pool.end();
  if (restoreCreated) await admin.query(`drop database ${restoreDatabase}`);
  if (created) await admin.query(`drop database ${database}`);
  await admin.end();
  evidence.completedAt = new Date().toISOString();
  await writeFile(join(reportDir, 'rollback-evidence.json'), JSON.stringify(evidence, null, 2));
}
