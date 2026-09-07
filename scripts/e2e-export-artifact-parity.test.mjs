import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

// Execute the actual runner's parity check with its declared crypto imports.
// This catches an undeclared hash function as well as a weakened comparison.
const source = readFileSync(new URL("./test-e2e-real.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("runner.mjs", source, ts.ScriptTarget.Latest, true);
const blocks = []; const imports = {};
for (const node of ast.statements) {
  if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== "node:crypto") continue;
  for (const element of node.importClause?.namedBindings?.elements ?? []) {
    imports[element.name.text] = crypto[element.propertyName?.text ?? element.name.text];
  }
}
const visit = node => {
  if (ts.isForOfStatement(node) && node.expression.getText(ast) === "projectExportEvidence") blocks.push(node.getText(ast));
  ts.forEachChild(node, visit);
};
visit(ast); assert.equal(blocks.length, 1);
function run(kind) {
  const exportBuffers = new Map(["csv", "xlsx", "pdf"].map(format => [format, Buffer.from(`synthetic ${format} artifact`)]));
  const projectExportEvidence = [...exportBuffers].map(([format, bytes]) => ({ format,
    byte_size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }));
  if (kind === "hash") projectExportEvidence[1].sha256 = "0".repeat(64);
  if (kind === "size") projectExportEvidence[1].byte_size++;
  if (kind === "missing") exportBuffers.delete("pdf");
  return vm.runInNewContext(blocks[0], { assert, ...imports, exportBuffers, projectExportEvidence });
}
it("checks all three actual saved export bytes against their durable artifacts", () => expect(() => run("valid")).not.toThrow());
it.each(["hash", "size", "missing"])("rejects %s without accepting a missing runtime dependency", kind => {
  expect(() => run(kind)).toThrow("downloaded UI export differs from its exact durable artifact");
});
