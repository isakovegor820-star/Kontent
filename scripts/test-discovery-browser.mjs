import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
// Local UI verification only. All API responses use synthetic fixtures; no account writes.
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright-core');
const output = fileURLToPath(new URL('../reports/discovery-guide-2026-09-14', import.meta.url));
mkdirSync(output, { recursive: true });
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(localChrome) ? { executablePath: localChrome } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const project = { id: 99001, name: 'Проверка интерфейса', timezone: 'Europe/Moscow', role: 'owner', selected: true, version: 1, personal: true };
await context.route('**/api/**', async route => {
 const path = new URL(route.request().url()).pathname;
 let body = { ok: true, items: [], posts: [], channels: [], drafts: [], notifications: [], generations: [], models: [], engines: [], current: null, total: 0, hasMore: false, unreadCount: 0 };
 if (path === '/api/auth/me') body = { user: { id: 99001, email: 'preview@example.test', name: 'Проверка интерфейса', onboarding_completed_at: '2026-01-01', is_admin: false } };
 if (path === '/api/projects') body = { ok: true, projects: [project] };
 if (path === '/api/projects/current') body = { ok: true, project };
 if (path === '/api/posts') body = { projectId: 99001, posts: [], pageInfo: { snapshotVersion: '1', hasMore: false, nextCursor: null } };
 if (path === '/api/ai/usage') body = { status: 'ok', used: 0, limit: 30 };
 await route.fulfill({ json: body });
});
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
 await page.goto(`${process.env.AURORA_DISCOVERY_BASE_URL || 'http://localhost:3100'}/app/calendar`, { waitUntil: 'domcontentloaded', timeout: 60000 });
 await page.getByRole('button', { name: 'Поиск по Авроре', exact: true }).waitFor({ timeout: 60000 });
 await page.screenshot({ path: output + '/desktop.png' });
 await page.getByRole('button', { name: 'Поиск по Авроре', exact: true }).click();
 await page.getByRole('searchbox', { name: 'Что хотите сделать?' }).fill('подключить канал');
 await page.screenshot({ path: output + '/search-desktop.png' });
 console.log(JSON.stringify({ url: page.url(), links: await page.locator('[data-discovery-result]').evaluateAll(elements => elements.map(el => ({ text: el.innerText, href: el.getAttribute('href') }))), errors }));
 await page.keyboard.press('Escape');
 await page.getByRole('button', { name: 'Гид Авроры — объяснить экран', exact: true }).click();
 await page.screenshot({ path: output + '/guide-desktop.png' });
 await page.getByRole('button', { name: 'Показать, как', exact: true }).click();
 await page.waitForTimeout(500);
 await page.screenshot({ path: output + '/tour-desktop.png' });
 await page.getByRole('button', { name: 'Закрыть гида', exact: true }).click();
 await page.setViewportSize({ width: 390, height: 844 });
 await page.screenshot({ path: output + '/mobile.png' });
 await page.getByRole('button', { name: 'Поиск по Авроре', exact: true }).click();
 await page.getByRole('searchbox').fill('написать пост');
 await page.screenshot({ path: output + '/search-mobile.png' });
 await page.keyboard.press('Escape');
 await page.getByRole('button', { name: 'Гид Авроры — объяснить экран', exact: true }).click();
 await page.screenshot({ path: output + '/guide-mobile.png' });
 await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
 assert.equal(await page.locator('#aurora-guide-panel').count(), 0, 'guide must not cover the mobile navigation dialog');
 await page.getByRole('button', { name: 'Объяснить раздел «Студия контента»', exact: true }).click();
 await page.locator('#aurora-guide-panel').waitFor();
 assert.equal(await page.getByRole('dialog', { name: 'Меню платформы' }).count(), 0);
 assert.match(await page.locator('#aurora-guide-panel').innerText(), /Подготовка контента с Авророй/);
 await page.getByRole('button', { name: 'Закрыть гида', exact: true }).click();
 const geometry = [];
 for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 768, 390, 320]) {
  await page.setViewportSize({ width, height: width <= 390 ? 568 : 900 });
  await page.evaluate(theme => { document.querySelector('.app-v3').setAttribute('data-theme', theme); window.scrollTo({ top: 0, behavior: 'instant' }); }, theme);
  const toolbar = await page.locator('.aurora-discovery-toolbar').evaluate(el => {
   const search = el.querySelector('.aurora-search-trigger').getBoundingClientRect();
   const guide = el.querySelector('.aurora-guide-trigger').getBoundingClientRect();
   return { search: search.toJSON(), guide: guide.toJSON(), pageWidth: document.documentElement.scrollWidth, width: innerWidth };
  });
  assert.ok(toolbar.search.right <= toolbar.guide.left + 1, 'toolbar controls must not overlap');
  if (toolbar.pageWidth > toolbar.width + 1) {
   toolbar.withoutDiscovery = await page.locator('.aurora-discovery-toolbar').evaluate(el => { const old = el.style.display; el.style.display = 'none'; const width = document.documentElement.scrollWidth; el.style.display = old; return width; });
   assert.equal(toolbar.pageWidth, toolbar.withoutDiscovery, 'discovery must not add horizontal page overflow');
  }
  assert.ok(toolbar.guide.right <= width + 1 && toolbar.search.left >= 0, 'new toolbar must fit viewport');
  await page.getByRole('button', { name: 'Поиск по Авроре', exact: true }).click();
  await page.getByRole('searchbox').fill('несуществующий запрос');
  await page.getByRole('button', { name: 'Сбросить поиск', exact: true }).click();
  await page.getByRole('searchbox').fill('написать пост');
  const metrics = await page.locator('.aurora-search-dialog').evaluate(el => {
   const box = el.getBoundingClientRect();
   const rgb = value => value.match(/[\d.]+/g).map(Number).slice(0,3);
   const luminance = value => rgb(value).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v+.055)/1.055)**2.4; }).reduce((sum,v,i) => sum+v*[.2126,.7152,.0722][i],0);
   const background = getComputedStyle(el).backgroundColor;
   const contrast = ['text-text','text-text-2','text-text-3','text-info-text'].map(cls => {
    const probe = document.createElement('span'); probe.className = cls; probe.textContent = 'Проверка'; el.append(probe);
    const color = getComputedStyle(probe).color; probe.remove(); const a = luminance(color), b = luminance(background);
    return { cls, color, background, ratio: (Math.max(a,b)+.05)/(Math.min(a,b)+.05) };
   });
   return { box: box.toJSON(), inputFont: parseFloat(getComputedStyle(el.querySelector('input')).fontSize), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, contrast };
  });
  assert.ok(metrics.contrast.every(pair => pair.ratio >= 4.5), 'search text contrast must meet AA');
  assert.ok(metrics.box.left >= 0 && metrics.box.right <= width + 1 && metrics.box.bottom <= (width <= 390 ? 568 : 900), 'dialog must fit viewport');
  if (width <= 390) assert.ok(metrics.inputFont >= 16, 'mobile input must avoid focus zoom');
  for (let i=0; i<15; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('[role="dialog"]'))), true, 'focus must stay in search'); }
  if ((theme === 'dark' && [1440,320].includes(width)) || (theme === 'light' && width === 320)) await page.screenshot({ path: output + `/search-${theme}-${width}.png` });
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'aurora-search-trigger');
  await page.getByRole('button', { name: 'Гид Авроры — объяснить экран', exact: true }).click();
  const guideBox = await page.locator('#aurora-guide-panel').boundingBox();
  assert.ok(guideBox.x >= 0 && guideBox.x + guideBox.width <= width + 1, 'guide must fit viewport');
  if (theme === 'dark' && [1440,320].includes(width)) await page.screenshot({ path: output + `/guide-${theme}-${width}.png` });
  await page.getByRole('button', { name: 'Свернуть гида', exact: true }).click();
  await page.getByRole('button', { name: 'Развернуть гида', exact: true }).click();
  await page.getByRole('button', { name: 'Закрыть гида', exact: true }).click();
  geometry.push({ theme, width, toolbar, dialog: metrics, guideBox });
 }
 writeFileSync(output + '/browser-verification.json', JSON.stringify({ errors, geometry, navigation: 'pending' }, null, 2));
 await page.setViewportSize({ width: 1440, height: 1000 });
 await page.getByRole('button', { name: 'Поиск по Авроре', exact: true }).click();
 await page.getByRole('searchbox').fill('подключить канал');
 await page.keyboard.press('Enter');
 await page.waitForURL('**/app/settings?section=channels&setting=channels');
 await page.locator('[data-setting-target="channels"]').waitFor();
 await page.getByRole('button', { name: 'Поиск по Авроре', exact: true }).click();
 await page.getByRole('searchbox', { name: 'Что хотите сделать?' }).fill('написать пост');
 await page.getByRole('link', { name: 'Показать, как: Написать пост', exact: true }).click();
 await page.waitForURL('**/app/studio?mode=chat&guide=studio');
 await page.locator('#aurora-guide-panel').waitFor();
 assert.match(await page.locator('#aurora-guide-panel').innerText(), /Опишите задачу/);
 await page.getByRole('button', { name: 'Закрыть гида', exact: true }).click();
 assert.equal(new URL(page.url()).searchParams.has('guide'), false, 'closing help cleans up only the guide URL parameter');
 assert.equal(new URL(page.url()).searchParams.get('mode'), 'chat');
 writeFileSync(output + '/browser-verification.json', JSON.stringify({ errors, geometry, checked: ['mobile menu explanation', 'keyboard focus containment and restoration', 'empty results reset', 'Enter navigation to setting', 'search to studio walkthrough', 'guide URL cleanup', 'light/dark at 5 widths', 'collapse/reopen'] }, null, 2));
 assert.deepEqual(errors, []);
 console.log('Discovery browser checks passed: 10 viewport/theme combinations, keyboard, navigation and guide lifecycle.');
} catch (error) {
 await page.screenshot({ path: output + '/failure.png' });
 console.log(JSON.stringify({ error: error.message, url: page.url(), text: (await page.locator('body').innerText()).slice(0, 5000), errors }));
 process.exitCode = 1;
} finally { await browser.close(); }
