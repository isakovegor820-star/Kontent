import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { patchFirefoxBindingSource } from "./e2e-firefox-binding-patch.mjs";
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("playwright-core/package.json"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const source = readFileSync(join(root, "lib/coreBundle.js"), "utf8");
it.each(["destroy-during-await", "absent-at-arrival", "initialization-error", "unchanged"])("preserves the exact received binding context: %s", async scenario => {
  const patched = patchFirefoxBindingSource(source, manifest.version);
  const start = patched.indexOf("      async _onBindingCalled(event) {\n        const context2 = this._contextIdToContext.get(event.executionContextId);");
  const fallback = patched.indexOf("      async _onBindingCalled(event) {\n        const pageOrError = await this._page.waitForInitializedOrError();");
  const offset = start >= 0 ? start : fallback;
  expect(offset).toBeGreaterThan(-1);
  const end = patched.indexOf("      async _onFileChooserOpened", offset);
  const handler = Function("return ({" + patched.slice(offset, end).trim() + "})._onBindingCalled")();
  let ready; const pending = new Promise(resolve => { ready = resolve; });
  const context = { id: "original" }; const calls = [];
  const receiver = { _contextIdToContext: new Map(scenario === "absent-at-arrival" ? [] : [["owned", context]]),
    _page: { waitForInitializedOrError: () => pending, onBindingCalled: async (...args) => { calls.push(args); } } };
  const event = { executionContextId: "owned", payload: "synthetic exact payload" };
  const work = handler.call(receiver, event);
  if (scenario === "destroy-during-await") receiver._contextIdToContext.delete("owned");
  if (scenario === "absent-at-arrival") receiver._contextIdToContext.set("owned", { id: "later" });
  ready(scenario === "initialization-error" ? new Error("initialization failed") : {}); await work;
  expect(calls).toHaveLength(["destroy-during-await", "unchanged"].includes(scenario) ? 1 : 0);
  if (calls.length) { expect(calls[0][0]).toBe(event.payload); expect(calls[0][1]).toBe(context); }
});
it("rejects unreviewed versions, absent handlers, duplicates and already-patched source", () => {
  expect(() => patchFirefoxBindingSource(source, "1.62.0")).toThrow();
  expect(() => patchFirefoxBindingSource("", manifest.version)).toThrow();
  expect(() => patchFirefoxBindingSource(source + source, manifest.version)).toThrow();
  expect(() => patchFirefoxBindingSource(patchFirefoxBindingSource(source, manifest.version), manifest.version)).toThrow();
});
