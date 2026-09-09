import { test } from "vitest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import ts from "typescript";
import * as auth from "./e2e-auth-coverage.mjs";
import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";

const digest = value => createHash("sha256").update(String(value)).digest("hex");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function runActualBoundary(primary, secondary = []) {
  const source = await readFile(new URL("./e2e-auth-coverage.mjs", import.meta.url), "utf8");
  const ast = ts.createSourceFile("auth.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "runAuthCoverage");
  const outer = fn.body.statements.find(ts.isTryStatement); assert(outer.catchClause && outer.finallyBlock);
  const order = []; const evidence = []; const noop = () => {};
  const browserErrors = { snapshot: () => ({ unexpected: [] }) };
  const bindings = { primary, createHash, assert, safeAuthCoverageError: auth.safeAuthCoverageError,
    finalizeE2eBrowserLifecycle, failures: [], artifactDir: "/own-artifact", mkdir: noop,
    context: { close: async () => { order.push("close"); if (secondary[0]) throw secondary[0]; } },
    transport: { stop: async () => { order.push("transport-stop"); if (secondary[1]) throw secondary[1]; }, assertClean: noop, snapshot: () => [] },
    boundary: { assertClean: noop, snapshot: () => [] }, browserErrors,
    diagnostics: { flush: async () => order.push("flush"), stop: () => order.push("diagnostics-stop"),
      assertClean: () => { order.push("diagnostics-assert"); if (secondary[2]) throw secondary[2]; }, snapshot: () => ({ phase: "reset-password", browserErrors: browserErrors.snapshot() }) },
    writeFile: async (_path, value) => { order.push("write"); evidence.push(JSON.parse(value)); if (secondary[3]) throw secondary[3]; },
  };
  let failure;
  try { await new AsyncFunction(...Object.keys(bindings), "let failure; let result; try { throw primary; } " + outer.catchClause.getText(ast) + " finally " + outer.finallyBlock.getText(ast))(...Object.values(bindings)); }
  catch (error) { failure = error; }
  assert(failure, "privacy correction must retain the failure outcome");
  return { failure, order, evidence };
}
function visibleError(value) { return [String(value), value.stack, inspect(value, { depth: 10 }), JSON.stringify(value)].join("\n"); }
function errorFacts(value, seen = new Set()) {
  if (!value || seen.has(value)) return []; seen.add(value);
  return [value.authFailure, ...(Array.isArray(value.errors) ? value.errors.flatMap(error => errorFacts(error, seen)) : []), ...errorFacts(value.cause, seen)].filter(Boolean);
}
for (const count of [0, 1, 3, 4]) {
  test(`the actual Auth catch/finally boundary redacts a native-like primary plus ${count} cleanup failures`, async () => {
    const canary = randomUUID(); const primary = new Error("page.goto failed at https://127.0.0.1:63345/reset-password#token=" + canary);
    primary.name = "TimeoutError";
    const secondary = Array.from({ length: count }, (_, index) => new Error(`cleanup ${index} ${canary}`));
    const { failure, order, evidence } = await runActualBoundary(primary, secondary);
    assert.equal(visibleError(failure).includes(canary), false, "the parent error serialization must not contain the reset canary");
    assert.equal(JSON.stringify(evidence).includes(canary), false);
    assert.equal(visibleError(failure).includes(primary.message), false);
    const facts = errorFacts(failure);
    for (const original of [primary, ...secondary]) assert(facts.some(fact => fact.messageHash === digest(original.message) && fact.name === original.name), "every primary/secondary retains exact safe type and hash");
    assert.deepEqual(order, ["flush", "close", "transport-stop", "flush", "diagnostics-stop", "diagnostics-assert", "write"]);
    assert.equal(evidence.at(-1).complete, false);
  });
}
test("raw nested causes, stacks and custom error names cannot carry the reset value", async () => {
  const canary = randomUUID(); const cause = new Error("inner " + canary); const primary = new Error("top", { cause });
  primary.name = "custom " + canary; primary.stack = "stack " + canary;
  const { failure } = await runActualBoundary(primary);
  assert.equal(visibleError(failure).includes(canary), false);
  assert(errorFacts(failure).some(fact => fact.messageHash === digest(cause.message)));
  assert(failure.message.includes(digest(cause.message)), "serialized parent message retains nested cause hash");
  assert.equal(failure.authFailure.nameHash, digest(primary.name));
});
test("repeated sanitization retains original safe failure hashes without reintroducing raw references", async () => {
  const canary = randomUUID(); const primary = new Error(canary);
  const first = await runActualBoundary(primary); const second = await runActualBoundary(first.failure);
  assert.equal(visibleError(second.failure).includes(canary), false);
  assert(errorFacts(second.failure).some(fact => fact.messageHash === digest(primary.message)));
});
