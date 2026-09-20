// Requires scripts/autopilot-qa-runtime.mjs: disposable DB, Redis and full dev runtime.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { chromium } from 'playwright-core';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const directory = (await readFile('reports/autopilot-calendar-2026-09-07/runtime-path.txt', 'utf8')).trim();
const runtime = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8'));
const target = new URL(runtime.databaseUrl);
assert(['localhost', '127.0.0.1'].includes(target.hostname) && /^aurora_autopilot_qa_[a-f0-9]+$/u.test(target.pathname.slice(1)));
assert(new URL(runtime.redisUrl).port !== '6379');
const db = new pg.Pool({ connectionString: runtime.databaseUrl, ssl: false, max: 2 });
const redis = new IORedis(runtime.redisUrl, { maxRetriesPerRequest: null });
redis.on('error', () => {});
const queue = new Queue('autopilot-plans', { connection: redis });
const reportDir = 'reports/autopilot-settings-2026-09-08';
await mkdir(reportDir, { recursive: true });
let browser;
let page;
const checks = [];
const pass = (message) => { checks.push(message); console.log(`PASS ${message}`); };
try {
  assert(await queue.getWorkersCount() >= 1);
  const userId = Number((await db.query(`insert into users (email, name, onboarding_completed_at) values ($1, 'Анна · QA', now()) returning id`, [`settings-${randomBytes(5).toString('hex')}@aurora.test`])).rows[0].id);
  const projectId = Number((await db.query(`insert into projects (name, timezone, created_by_user_id, personal_owner_user_id) values ('Настройки автопилота · QA', 'Europe/Moscow', $1, $1) returning id`, [userId])).rows[0].id);
  await db.query(`insert into project_members (project_id, user_id, role, status) values ($1, $2, 'owner', 'active')`, [projectId, userId]);
  await db.query(`insert into user_project_preferences (user_id, selected_project_id) values ($1, $2)`, [userId, projectId]);
  const channels = [];
  for (const [index, title] of ['Первый канал', 'Второй канал'].entries()) {
    const channelId = Number((await db.query(`insert into channels (project_id, user_id, network, tg_chat_id, title, is_active) values ($1, $2, 'tg', $3, $4, true) returning id`, [projectId, userId, -9000000000 - userId * 10 - index, title])).rows[0].id);
    channels.push(channelId);
    await db.query(`insert into content_brief (project_id, user_id, channel_id, niche, audience, ready, source) values ($1, $2, $3, 'Редакционная работа', 'Авторы и редакторы', true, 'manual')`, [projectId, userId, channelId]);
    await db.query(`insert into autopilot_settings (project_id, user_id, channel_id, enabled, mode, post_frequency, planning_weeks, quick_settings) values ($1, $2, $3, false, 'confirm', $4, 2, $5::jsonb)`, [projectId, userId, channelId, index ? 2 : 7, JSON.stringify({ newsPerWeek: 1, detail: 2, energy: 2, emoji: 1 })]);
  }
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await db.query(`insert into sessions (token_hash, token, user_id, expires_at, credential_epoch) select $1, $1, id, now() + interval '1 day', credential_epoch from users where id = $2`, [hash, userId]);
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, baseURL: runtime.baseUrl });
  await context.addCookies([{ name: 'sid', value: token, url: runtime.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
  await context.route('**/*', (route) => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(180000);
  const settingsPath = `/app/settings?section=autopilot&channel=${channels[0]}`;
  await page.goto(settingsPath, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Как Аврора планирует' }).waitFor();
  assert.equal(await page.getByRole('slider').count(), 6);
  assert.equal(await page.locator('#channel-autopilot-frequency').inputValue(), '7');
  await page.screenshot({ path: join(reportDir, 'desktop-entry.png'), fullPage: true });
  pass('Все шесть ползунков, модель и переключатель доступны сразу при входе');
  for (const [id, value] of Object.entries({ frequency: '3', weeks: '7', news: '1', detail: '3', energy: '1', emoji: '0' })) {
    const control = page.locator(`#channel-autopilot-${id}`);
    await control.focus();
    await control.press('Home');
    const min = Number(await control.getAttribute('min'));
    for (let step = min; step < Number(value); step++) await control.press('ArrowRight');
    assert.equal(await control.inputValue(), value);
  }
  await page.locator('#channel-autopilot-engine').selectOption('navy-gpt-5-4');
  const savedResponse = page.waitForResponse((r) => r.url().endsWith('/api/autopilot/settings') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Сохранить автопилот', exact: true }).click();
  assert.equal((await savedResponse).status(), 200);
  await page.getByText('Все изменения сохранены', { exact: true }).waitFor();
  assert(await page.getByRole('heading', { name: 'Как Аврора планирует' }).isVisible());
  const row = (await db.query(`select enabled, post_frequency, planning_weeks, generation_engine, quick_settings from autopilot_settings where project_id=$1 and channel_id=$2`, [projectId, channels[0]])).rows[0];
  assert.deepEqual(row, { enabled: false, post_frequency: 3, planning_weeks: 7, generation_engine: 'navy-gpt-5-4', quick_settings: { newsPerWeek: 1, detail: 3, energy: 1, emoji: 0 } });
  await page.reload();
  await page.getByRole('heading', { name: 'Как Аврора планирует' }).waitFor();
  assert.equal(await page.locator('#channel-autopilot-weeks').inputValue(), '7');
  pass('Настройки записаны в PostgreSQL, форма открыта после сохранения и перезагрузки');
  const channelResponse = page.waitForResponse((r) => r.url().includes(`/api/settings/channel?channel=${channels[1]}`));
  await page.getByRole('button', { name: 'Второй канал', exact: true }).click();
  await channelResponse;
  await page.getByRole('heading', { name: 'Как Аврора планирует' }).waitFor();
  assert.equal(await page.locator('#channel-autopilot-frequency').inputValue(), '2');
  pass('Смена канала открывает его собственные настройки');
  await page.goto(`/app/autopilot?channel=${channels[0]}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Параметры плана', exact: true }).click();
  assert.equal(await page.locator('#autopilot-horizon').inputValue(), '7');
  for (const [id, value] of Object.entries({ news: '1', detail: '3', energy: '1', emoji: '0' })) assert.equal(await page.locator(`#autopilot-${id}`).inputValue(), value);
  assert.equal(await page.locator('#autopilot-news').getAttribute('max'), '3');
  assert.equal(await page.getByRole('link', { name: 'Настройки канала', exact: true }).getAttribute('href'), settingsPath);
  await page.screenshot({ path: join(reportDir, 'autopilot-saved-settings.png'), fullPage: true });
  pass('Основной раздел автопилота получил настройки; доля новостей учитывает частоту канала');
  await page.getByRole('link', { name: 'Настройки канала', exact: true }).click();
  await page.getByRole('heading', { name: 'Как Аврора планирует' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(reportDir, 'mobile-settings.png'), fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  pass('Ссылка ведёт прямо к настройкам автопилота; на телефоне нет горизонтального переполнения');
  assert.deepEqual(errors, []);
  await writeFile(join(reportDir, 'checks.json'), JSON.stringify({ checks, pageErrors: errors, workers: await queue.getWorkersCount() }, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(reportDir, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await queue.close(); redis.disconnect(); await db.end();
}
