import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const roots = ["src", "worker", "scripts"];
const extensions = /\.(?:[cm]?[jt]sx?)$/u;
const focused = /\b(?:describe|it|test)\.(?:only|skip)\s*\(/gu;
const violations = [];

async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const target = resolve(path, entry.name);
    if (entry.isDirectory()) await visit(target);
    else if (extensions.test(entry.name)) {
      extensions.lastIndex = 0;
      const source = await readFile(target, "utf8");
      if (focused.test(source)) violations.push(target);
      focused.lastIndex = 0;
    }
  }
}

for (const root of roots) await visit(resolve(root));
if (violations.length) {
  console.error(`Focused/skipped tests are forbidden:\n${violations.join("\n")}`);
  process.exit(1);
}
console.log("No focused or skipped tests found.");
