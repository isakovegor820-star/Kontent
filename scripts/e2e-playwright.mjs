import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { patchFirefoxBindingSource } from "./e2e-firefox-binding-patch.mjs";

// Own copy only: never rewrite the project's installed dependencies. Remove this
// workaround when an upstream release passes the unchanged binding regressions.
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("playwright-core/package.json"));
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const source = readFileSync(join(packageRoot, "lib/coreBundle.js"), "utf8");
const patched = patchFirefoxBindingSource(source, manifest.version);
const owned = mkdtempSync(join(tmpdir(), "aurora-e2e-playwright-"));
process.once("exit", () => rmSync(owned, { recursive: true, force: true }));
const copied = join(owned, "playwright-core");
cpSync(packageRoot, copied, { recursive: true, dereference: true });
writeFileSync(join(copied, "lib/coreBundle.js"), patched);
export const { chromium, firefox, webkit } = require(copied);
export const e2ePlaywrightProof = Object.freeze({ version: manifest.version,
  sourceHash: createHash("sha256").update(source).digest("hex"),
  patchedHash: createHash("sha256").update(patched).digest("hex"),
  change: "Firefox binding context retained across bounded reload teardown; owned dependency copy only" });
console.log(JSON.stringify({ e2ePlaywright: e2ePlaywrightProof }));
