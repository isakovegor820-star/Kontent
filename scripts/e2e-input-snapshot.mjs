import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const E2E_INPUT_DIRECTORIES = Object.freeze(["db", "public", "scripts", "src", "worker"]);
const E2E_INPUT_FILES = Object.freeze([
  "next.config.ts",
  "package-lock.json",
  "package.json",
  "postcss.config.mjs",
  "sentry.edge.config.ts",
  "sentry.server.config.ts",
  "sentry.worker.config.mjs",
  "tsconfig.json",
  "worker.mjs",
]);

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function captureE2eInputSnapshot(cwd = globalThis.process.cwd()) {
  const files = [
    ...await Promise.all(E2E_INPUT_DIRECTORIES.map((directory) => listFiles(resolve(cwd, directory))))
      .then((groups) => groups.flat()),
    ...E2E_INPUT_FILES.map((path) => resolve(cwd, path)),
  ];
  const inventory = await Promise.all([...new Set(files)].sort().map(async (path) => ({
    path: relative(cwd, path),
    bytes: (await stat(path)).size,
    sha256: await hashFile(path),
  })));
  const digest = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  return Object.freeze({ digest, files: Object.freeze(inventory) });
}

export function changedE2eInputPaths(baseline, current) {
  const baselineByPath = new Map(baseline.files.map((entry) => [entry.path, entry.sha256]));
  const currentByPath = new Map(current.files.map((entry) => [entry.path, entry.sha256]));
  return [...new Set([...baselineByPath.keys(), ...currentByPath.keys()])]
    .filter((path) => baselineByPath.get(path) !== currentByPath.get(path))
    .sort();
}
