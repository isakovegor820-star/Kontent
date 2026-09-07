import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveE2eTabKey } from './e2e-browser-config.mjs';

async function painted(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/** Validate measured native focus, including the fixed navigation's actual hit area. */
export function assertTodayFocusGeometry(row) {
  assert(row.found && row.focus && row.focusVisible, 'Today control must receive visible native keyboard focus');
  assert(row.rect.width >= 44 - .01 && row.rect.height >= 44 - .01, 'Today control must retain its touch target');
  assert(row.rect.left >= 0 && row.rect.right <= row.clientWidth + .5
    && row.rect.top >= 0 && row.rect.bottom <= row.innerHeight + .5,
  'Focused Today control must be entirely in the viewport');
  assert(row.documentWidth <= row.clientWidth + .5 && row.bodyWidth <= row.clientWidth + .5,
    'Today focus navigation must not introduce horizontal overflow');
  assert.equal(row.hits.length, 3, 'All three native hit-test points are required');
  assert(row.hits.every(Boolean), 'Focused Today control is covered by another element');
  if (row.nativeZoom) {
    assert(Math.abs(row.outerWidth / row.innerWidth - 2) < .02,
      'Actual browser zoom must be 200%');
    assert(row.cssZoom === '1' && row.visualScale === 1,
      'CSS or pinch zoom must not substitute for browser zoom');
  }
}

/** Read-only Today interaction regression. The caller owns state fixtures, transport,
 * diagnostics and native screenshot handling. This never clicks a content action. */
export async function runTodayFocusCoverage({
  page, engine, artifactDir, phase = 'today', controlName, locator,
  viewportWidths = [320, 390, 640], nativeZoom = false, captureScreenshot,
}) {
  const url = new URL(page.url());
  assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/app/today',
    'Today focus QA requires the caller-owned local Today page');
  assert(locator || ['Готово', 'Вернуть'].includes(controlName), 'Exact Today control is required');
  assert(Array.isArray(viewportWidths) && viewportWidths.length > 0
    && viewportWidths.every(width => Number.isSafeInteger(width) && width > 0),
  'Today focus viewport matrix must contain positive integer widths');
  const target = locator ?? page.getByRole('button', { name: controlName, exact: true });
  assert.equal(await target.count(), 1, 'Today focus target must be unique');
  assert(await target.isEnabled(), 'Today focus target must be enabled');
  const originalViewport = page.viewportSize();
  const originalTheme = await page.locator('.app-v3').getAttribute('data-theme');
  const report = { phase, controlName: controlName ?? 'exact caller locator', engine,
    nativeZoom, originalViewport, originalTheme, rows: [], errors: [] };
  const widths = nativeZoom ? [await page.evaluate(() => innerWidth)] : viewportWidths;
  const tabKey = resolveE2eTabKey({ engine, platform: process.platform });
  try {
    for (const width of widths) {
      if (!nativeZoom) await page.setViewportSize({ width, height: originalViewport?.height ?? 900 });
      await painted(page);
      // Establish a known start only. Target focus and all scrolling that follows
      // come from native Tab/Option+Tab, never target.focus()/scrollIntoView().
      const start = page.getByRole('button', { name: 'Открыть меню', exact: true });
      assert.equal(await start.count(), 1);
      await start.focus();
      let found = false; let steps = 0;
      for (; steps < 70; steps++) {
        await page.keyboard.press(tabKey);
        await painted(page);
        if (await target.evaluate(element => element === document.activeElement)) {
          found = true; break;
        }
      }
      const row = await target.evaluate(element => {
        const r = element.getBoundingClientRect();
        const points = [[r.left + r.width / 2, r.top + r.height / 2],
          [r.left + Math.min(8, r.width / 3), r.top + Math.min(8, r.height / 3)],
          [r.right - Math.min(8, r.width / 3), r.bottom - Math.min(8, r.height / 3)]];
        const targets = points.map(([x, y]) => document.elementFromPoint(x, y));
        const nav = document.querySelector('nav[aria-label="Основные разделы"]');
        const nr = nav?.getBoundingClientRect();
        const scroller = document.scrollingElement;
        return { innerWidth, innerHeight, outerWidth, clientWidth: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
          scrollY, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
          focus: element === document.activeElement, focusVisible: element.matches(':focus-visible'),
          hits: targets.map(node => Boolean(node && (node === element || element.contains(node)))),
          hitTargets: targets.map(node => node ? { tag: node.tagName,
            navigation: node.closest('nav')?.getAttribute('aria-label') ?? null } : null),
          bottomNav: nr?.height ? { top: nr.top, bottom: nr.bottom, height: nr.height } : null,
          scrollingElement: scroller?.tagName, scrollPaddingEnd: scroller ? getComputedStyle(scroller).scrollPaddingBlockEnd : null,
          bottomInset: getComputedStyle(document.documentElement).getPropertyValue('--app-content-bottom-inset'),
          cssZoom: getComputedStyle(document.documentElement).zoom, visualScale: visualViewport.scale,
          theme: document.querySelector('.app-v3')?.getAttribute('data-theme'),
          forcedColors: matchMedia('(forced-colors: active)').matches };
      });
      Object.assign(row, { found, steps, tabKey, nativeZoom });
      try { assertTodayFocusGeometry(row); row.pass = true; }
      catch (error) { row.pass = false; row.error = error.message; }
      report.rows.push(row);
      if (captureScreenshot && artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await captureScreenshot(page, { path: join(artifactDir, `today-focus-${phase.replace(/[^a-z0-9_-]/giu, '-')}-${width}.png`), fullPage: false });
      }
    }
  } catch (error) { report.errors.push(error.message); }
  finally {
    try {
      if (originalViewport && !nativeZoom) { await page.setViewportSize(originalViewport); await painted(page); }
      report.restoredViewport = page.viewportSize();
      report.restoredTheme = await page.locator('.app-v3').getAttribute('data-theme');
      assert.deepEqual(report.restoredViewport, originalViewport, 'Today focus helper must restore caller viewport');
      assert.equal(report.restoredTheme, originalTheme, 'Today focus helper must retain caller theme');
    } catch (error) { report.errors.push(error.message); }
    report.ok = report.errors.length === 0 && report.rows.length === widths.length && report.rows.every(row => row.pass);
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, `today-focus-${phase.replace(/[^a-z0-9_-]/giu, '-')}.json`), JSON.stringify(report, null, 2) + '\n');
    }
  }
  const error = new assert.AssertionError({ message: 'Today native focus is obscured or unavailable', actual: report, expected: 'all exact focus/hit checks pass; caller viewport/theme restored' });
  if (!report.ok) { error.evidence = report; throw error; }
  return report;
}
