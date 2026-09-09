import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

const source = readFileSync(new URL("./test-e2e-real.mjs", import.meta.url), "utf8");
const start = source.indexOf("  const [refreshA, refreshB] = await page.evaluate");
const end = source.indexOf("  const libraryReferenceText =", start);
assert(start > 0 && end > start);
const block = source.slice(start, end);
function fixture(bodies = [{ ok: true, queued: 1 }, { ok: false, error: "request_in_progress" }]) {
  const releases = []; const consumed = [];
  const state = { Promise, Number, JSON, assert, userId: 1, channels: [11, 12], competitorIds: [21, 22],
    pool: { query: async sql => ({ rows: [sql.includes("count(*)") ? { n: 1 } : { status: "ready" }] }) },
    fetch: async () => {
      const index = releases.length;
      let release;
      const pending = new Promise(resolve => { release = resolve; }); releases.push(release);
      return { status: index === 0 ? 200 : 202, json: async () => {
        consumed.push(index); await pending;
        if (bodies[index] instanceof Error) throw bodies[index];
        return bodies[index];
      } };
    },
  };
  state.page = { evaluate: (callback, input) => callback(input) };
  vm.createContext(state);
  const result = vm.runInContext(`(async () => {${block}; return true;})()`, state);
  void result.catch(() => undefined);
  return { result, consumed, release: () => releases.forEach(resolve => resolve()) };
}
it("parallel refresh cannot permit navigation after headers but before both response bodies", async () => {
  const f = fixture(); let completed = false;
  void f.result.then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(completed).toBe(false); expect(f.consumed).toEqual([0, 1]);
  f.release(); await expect(f.result).resolves.toBe(true);
});
it.each([
  [{ ok: false, error: "server" }, { ok: false, error: "request_in_progress" }],
  [{ ok: true, queued: -1 }, { ok: false, error: "request_in_progress" }],
  [{ ok: true, queued: 1 }, { ok: true }],
  [new SyntaxError("truncated response"), { ok: false, error: "request_in_progress" }],
])("incomplete or invalid refresh bodies fail instead of accepting only status: %j", async bodies => {
  const f = fixture(bodies); f.release(); await expect(f.result).rejects.toThrow();
});
