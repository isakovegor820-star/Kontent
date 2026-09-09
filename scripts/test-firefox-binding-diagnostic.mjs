import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { verifyNativeWorkspacePolling } from './e2e-workspace-polling-native.mjs';

// Diagnostic experiment only: private copies of the pinned test dependency.
// The release gate continues to use the installed, unmodified Playwright.
const require = createRequire(import.meta.url);
const packagePath = require.resolve('playwright-core/package.json');
const packageRoot = dirname(packagePath);
const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
assert.equal(manifest.version, '1.61.1', 'Re-review the upstream handler before testing a different version');
const source = await readFile(join(packageRoot, 'lib/coreBundle.js'), 'utf8');
const startText = '      async _onBindingCalled(event) {\n        const pageOrError = await this._page.waitForInitializedOrError();';
assert.equal(source.split(startText).length, 2, 'Expected exactly one reviewed Firefox handler');
const start = source.indexOf(startText);
const end = source.indexOf('      async _onFileChooserOpened', start);
assert(end > start);
const original = source.slice(start, end).trim();
const candidate = original.replace('const pageOrError = await this._page.waitForInitializedOrError();',
  'const context2 = this._contextIdToContext.get(event.executionContextId);\n        const pageOrError = await this._page.waitForInitializedOrError();')
  .replace('          const context2 = this._contextIdToContext.get(event.executionContextId);\n', '');
assert.notEqual(candidate, original);
const artifacts = resolve('test-results/firefox-binding-diagnostic');
await mkdir(artifacts, { recursive: true });
const owned = await mkdtemp(join(tmpdir(), 'aurora-firefox-binding-'));
const report = { diagnosticOnly: true, playwright: manifest.version, platform: process.platform,
  sourceHash: createHash('sha256').update(source).digest('hex'), original, candidate, cycles: 20, rows: [],
  boundary: 'No installed dependency, product behavior, request guard or release oracle is changed. Own loopback fixtures only.' };
const save = () => writeFile(join(artifacts, 'result.json'), JSON.stringify(report, null, 2) + '\n');
try {
  for (const version of ['original', 'candidate']) {
    const root = join(owned, version, 'playwright-core');
    await cp(packageRoot, root, { recursive: true, dereference: true });
    if (version === 'candidate') await writeFile(join(root, 'lib/coreBundle.js'), source.replace(original, candidate));
    const { firefox } = require(root);
    const browser = await firefox.launch({ headless: true });
    try {
      for (let cycle = 1; cycle <= report.cycles; cycle++) {
        const row = { version, cycle }; const started = performance.now();
        try { row.evidence = await verifyNativeWorkspacePolling(browser); row.result = 'PASS'; }
        catch (error) { row.result = 'FAIL'; row.error = String(error); }
        row.seconds = Number(((performance.now() - started) / 1000).toFixed(2));
        report.rows.push(row); await save();
        if (row.result === 'FAIL' || cycle % 5 === 0) console.log(JSON.stringify({ version, cycle, result: row.result, seconds: row.seconds }));
      }
    } finally { await browser.close(); }
  }
  report.summary = ['original', 'candidate'].map(version => ({ version,
    passed: report.rows.filter(row => row.version === version && row.result === 'PASS').length,
    failed: report.rows.filter(row => row.version === version && row.result === 'FAIL').length }));
  await save(); console.log(JSON.stringify(report.summary));
  assert.equal(report.summary[1].failed, 0, 'Candidate still loses strict native evidence; it must not ship');
} finally {
  await save(); await rm(owned, { recursive: true, force: true });
}
