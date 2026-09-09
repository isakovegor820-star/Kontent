import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { patchFirefoxBindingSource } from "./e2e-firefox-binding-patch.mjs";
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("playwright-core/package.json"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const source = readFileSync(join(root, "lib/coreBundle.js"), "utf8");
afterEach(() => vi.useRealTimers());
const method = (patched, start, end) => {
  const offset = patched.indexOf(start); expect(offset).toBeGreaterThan(-1);
  const limit = patched.indexOf(end, offset); expect(limit).toBeGreaterThan(offset);
  return Function("return ({" + patched.slice(offset, limit).trim() + "})." + /_(?:on\w+)/u.exec(start)[0])();
};
it.each(["destroy-before-arrival", "destroy-during-await", "absent-at-arrival", "initialization-error", "unchanged"])("preserves the exact received binding context: %s", async scenario => {
  const patched = patchFirefoxBindingSource(source, manifest.version);
  const destroy = method(patched, "_onExecutionContextDestroyed(payload) {", "      _onExecutionContextsCleared");
  const handler = method(patched, "async _onBindingCalled(event) {\n        const context2 = this._contextIdToContext.get(event.executionContextId) ??", "      async _onFileChooserOpened");
  let ready; const pending = new Promise(resolve => { ready = resolve; });
  const context = { id: "original", frame: { contextDestroyed: () => {} } }; const calls = [];
  const receiver = { _contextIdToContext: new Map(scenario === "absent-at-arrival" ? [] : [["owned", context]]),
    _destroyedContextIdToContext: new Map(),
    _page: { waitForInitializedOrError: () => pending, onBindingCalled: async (...args) => { calls.push(args); } } };
  const event = { executionContextId: "owned", payload: "synthetic exact payload" };
  if (scenario === "destroy-before-arrival") destroy.call(receiver, { executionContextId: "owned" });
  const work = handler.call(receiver, event);
  if (scenario === "destroy-during-await") destroy.call(receiver, { executionContextId: "owned" });
  if (scenario === "absent-at-arrival") receiver._contextIdToContext.set("owned", { id: "later" });
  ready(scenario === "initialization-error" ? new Error("initialization failed") : {}); await work;
  expect(calls).toHaveLength(["destroy-before-arrival", "destroy-during-await", "unchanged"].includes(scenario) ? 1 : 0);
  if (calls.length) { expect(calls[0][0]).toBe(event.payload); expect(calls[0][1]).toBe(context); }
});
it("prefers a live reused context ID and evicts its stale destroyed entry on creation", () => {
  const patched = patchFirefoxBindingSource(source, manifest.version);
  expect(patched).toContain("const { executionContextId, auxData } = payload;\n        this._destroyedContextIdToContext.delete(executionContextId);");
  expect(patched).toContain("this._contextIdToContext.get(event.executionContextId) ?? this._destroyedContextIdToContext.get(event.executionContextId)");
});
it("expires a destroyed context after the bounded delivery window", () => {
  vi.useFakeTimers(); const patched = patchFirefoxBindingSource(source, manifest.version);
  const destroy = method(patched, "_onExecutionContextDestroyed(payload) {", "      _onExecutionContextsCleared");
  const context = { frame: { contextDestroyed: () => {} } };
  const receiver = { _contextIdToContext: new Map([["owned", context]]), _destroyedContextIdToContext: new Map() };
  destroy.call(receiver, { executionContextId: "owned" });
  expect(receiver._destroyedContextIdToContext.get("owned")).toBe(context);
  vi.advanceTimersByTime(4_999); expect(receiver._destroyedContextIdToContext.get("owned")).toBe(context);
  vi.advanceTimersByTime(1); expect(receiver._destroyedContextIdToContext.has("owned")).toBe(false);
});
it("rejects unreviewed versions, absent handlers, duplicates and already-patched source", () => {
  expect(() => patchFirefoxBindingSource(source, "1.62.0")).toThrow();
  expect(() => patchFirefoxBindingSource("", manifest.version)).toThrow();
  expect(() => patchFirefoxBindingSource(source + source, manifest.version)).toThrow();
  expect(() => patchFirefoxBindingSource(patchFirefoxBindingSource(source, manifest.version), manifest.version)).toThrow();
});
