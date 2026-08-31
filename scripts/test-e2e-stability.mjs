import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { selectFreshJourneyFailureDetail } from "./e2e-stability-artifacts.mjs";
import {
  E2E_BOT_CONNECT_TOKEN_CANARY,
  inspectE2eCanaryBuffer,
  inspectE2eNetworkEvents,
  inspectE2eTextEvidence,
} from "./e2e-evidence-safety.mjs";
import { captureE2eInputSnapshot, changedE2eInputPaths } from "./e2e-input-snapshot.mjs";
import { createE2eStabilityPlan } from "./e2e-stability-config.mjs";

const plan = createE2eStabilityPlan({
  runs: process.env.E2E_STABILITY_RUNS,
  engines: process.env.E2E_STABILITY_ENGINES,
  initialBuildMode: process.env.E2E_STABILITY_INITIAL_BUILD_MODE,
});
const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
const artifactRoot = resolve(
  String(process.env.E2E_STABILITY_ARTIFACT_DIR || `test-results/e2e-stability/${stamp}`),
);
const dryRun = String(process.env.E2E_STABILITY_DRY_RUN || "0") === "1";
const manifestPath = join(artifactRoot, "manifest.json");
const manifest = {
  version: 2,
  status: dryRun ? "dry-run" : "running",
  startedAt: new Date().toISOString(),
  completedAt: null,
  expectedCycles: plan.runs,
  engines: plan.engines,
  expectedJourneys: plan.expectedJourneys,
  completedJourneys: 0,
  failedJourneys: 0,
  flakeRate: null,
  inputSnapshot: null,
  journeys: [],
};
let baselineInputSnapshot;

async function writeManifest() {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function artifactInventory(directory) {
  const files = await listFiles(directory);
  return Promise.all(files.map(async (path) => ({
    path: relative(directory, path),
    bytes: (await stat(path)).size,
    sha256: await hashFile(path),
  })));
}

const E2E_TEXT_EVIDENCE_SUFFIXES = Object.freeze([
  ".csv",
  ".html",
  ".json",
  ".log",
  ".md",
  ".txt",
]);
const E2E_ARCHIVE_EVIDENCE_SUFFIXES = Object.freeze([".xlsx", ".zip"]);
const E2E_EVIDENCE_CANARIES = Object.freeze([
  Object.freeze({ label: "bot-connect-token", value: E2E_BOT_CONNECT_TOKEN_CANARY }),
]);

function extractArchiveContent(path) {
  return new Promise((resolveExtract, rejectExtract) => {
    execFile(
      "unzip",
      ["-p", path],
      { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectExtract(new Error(
            `unable to inspect archive ${path}: ${String(stderr || error.message).trim()}`,
          ));
          return;
        }
        resolveExtract(Buffer.from(stdout));
      },
    );
  });
}

async function scanJourneyEvidence(directory, inventory, networkEvents) {
  const findings = [...inspectE2eNetworkEvents(networkEvents)];
  let textFilesScanned = 0;
  let archivesExpanded = 0;
  for (const entry of inventory) {
    const path = join(directory, entry.path);
    const content = await readFile(path);
    findings.push(...inspectE2eCanaryBuffer(entry.path, content, E2E_EVIDENCE_CANARIES));
    if (E2E_TEXT_EVIDENCE_SUFFIXES.some((suffix) => entry.path.endsWith(suffix))) {
      textFilesScanned += 1;
      findings.push(...inspectE2eTextEvidence(entry.path, content.toString("utf8")));
    }
    if (E2E_ARCHIVE_EVIDENCE_SUFFIXES.some((suffix) => entry.path.endsWith(suffix))) {
      archivesExpanded += 1;
      const expanded = await extractArchiveContent(path);
      findings.push(...inspectE2eCanaryBuffer(
        `${entry.path}::expanded`,
        expanded,
        E2E_EVIDENCE_CANARIES,
      ));
    }
  }
  if (findings.length > 0) {
    const detail = findings.slice(0, 20).map((finding) => [
      finding.kind,
      finding.path,
      Number.isSafeInteger(finding.index) ? `event:${finding.index}` : null,
      finding.parameter ? `parameter:${finding.parameter}` : null,
      finding.label ? `canary:${finding.label}` : null,
    ].filter(Boolean).join("/")).join(", ");
    throw new Error(`E2E evidence safety scan found ${findings.length} issue(s): ${detail}`);
  }
  return {
    filesScanned: inventory.length,
    textFilesScanned,
    archivesExpanded,
    networkEventsScanned: networkEvents.length,
    canaries: E2E_EVIDENCE_CANARIES.map(({ label }) => label),
    findings: 0,
  };
}

async function assertStableE2eInputs() {
  const current = await captureE2eInputSnapshot();
  if (current.digest === baselineInputSnapshot.digest) return;
  const changedPaths = changedE2eInputPaths(baselineInputSnapshot, current);
  throw new Error(
    `E2E inputs changed during the stability gate: ${changedPaths.slice(0, 20).join(", ")}`,
  );
}

function runJourney(journey, directory) {
  return new Promise((resolveRun) => {
    const chunks = [];
    const subprocess = spawn(globalThis.process.execPath, [resolve("scripts/test-e2e-real.mjs")], {
      cwd: globalThis.process.cwd(),
      env: {
        ...globalThis.process.env,
        E2E_BROWSER: journey.engine,
        E2E_BUILD_MODE: journey.buildMode,
        E2E_CAPTURE_ARTIFACTS: "1",
        E2E_ARTIFACT_DIR: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [subprocess.stdout, subprocess.stderr]) {
      stream.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        globalThis.process.stderr.write(chunk);
      });
    }
    subprocess.once("exit", (code, signal) => resolveRun({
      code: Number.isInteger(code) ? code : 1,
      signal: signal || null,
      output: Buffer.concat(chunks).toString("utf8").slice(-500_000),
    }));
  });
}

async function verifyJourney(directory) {
  const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
  const diagnostics = JSON.parse(await readFile(join(directory, "browser-diagnostics.json"), "utf8"));
  const network = JSON.parse(await readFile(join(directory, "network-log.json"), "utf8"));
  const inventory = await artifactInventory(directory);
  const paths = inventory.map((entry) => entry.path);
  const traces = paths.filter((path) => path.endsWith("-trace.zip"));
  const videos = paths.filter((path) => path.endsWith(".webm"));
  const screenshots = paths.filter((path) => path.startsWith("interface-") && path.endsWith(".png"));
  if (result.ok !== true) throw new Error(`result is not green: ${result.error || "unknown"}`);
  if (diagnostics.issues?.length !== 0) throw new Error("browser diagnostics contains unexpected issues");
  if (result.artifacts?.enabled !== true) throw new Error("heavy browser artifacts were not enabled");
  if (traces.length !== 2) throw new Error(`expected 2 traces, found ${traces.length}`);
  if (videos.length < 2) throw new Error(`expected at least 2 videos, found ${videos.length}`);
  if (screenshots.length < 5) throw new Error(`expected at least 5 screenshots, found ${screenshots.length}`);
  if (!Array.isArray(network.events) || network.events.length === 0) {
    throw new Error("network log is empty");
  }
  const evidenceSafety = await scanJourneyEvidence(directory, inventory, network.events);
  return {
    result: {
      ok: result.ok,
      browserEngine: result.browserEngine,
      buildMode: result.buildMode,
      fixtureClockAdvanced: result.fixtureClockAdvanced,
      browserRuntimeErrors: result.criticalJourney?.interface?.browserRuntimeErrors,
      browserKnownObservations: result.criticalJourney?.interface?.browserKnownObservations,
    },
    diagnostics: {
      issues: diagnostics.issues.length,
      observations: diagnostics.observations?.length ?? 0,
    },
    networkEvents: network.events.length,
    evidenceSafety,
    inventory,
  };
}

async function failedJourneyDetail(directory, output, journeyStartedAtMs) {
  let resultError = null;
  let resultModifiedAtMs = null;
  try {
    const resultPath = join(directory, "result.json");
    const [result, resultStats] = await Promise.all([
      readFile(resultPath, "utf8").then(JSON.parse),
      stat(resultPath),
    ]);
    resultError = result?.error;
    resultModifiedAtMs = resultStats.mtimeMs;
  } catch {}
  return selectFreshJourneyFailureDetail({
    resultError,
    resultModifiedAtMs,
    journeyStartedAtMs,
    output,
  });
}

await mkdir(artifactRoot, { recursive: true });
baselineInputSnapshot = await captureE2eInputSnapshot();
manifest.inputSnapshot = baselineInputSnapshot;
await writeManifest();

if (dryRun) {
  manifest.plannedJourneys = plan.journeys;
  manifest.completedAt = new Date().toISOString();
  await writeManifest();
  console.log(JSON.stringify({ ok: true, dryRun: true, artifactRoot, plan }));
  globalThis.process.exit(0);
}

for (const journey of plan.journeys) {
  const directory = join(artifactRoot, journey.artifactDirectory);
  await mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.parse(startedAt);
  let execution = { code: null, signal: null, output: "" };
  let evidence = null;
  let error = null;
  try {
    await assertStableE2eInputs();
    execution = await runJourney(journey, directory);
    if (execution.code !== 0) {
      throw new Error(
        `journey exited with code ${execution.code}${await failedJourneyDetail(directory, execution.output, startedAtMs)}`,
      );
    }
    await assertStableE2eInputs();
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  await writeFile(join(directory, "runner.log"), execution.output, "utf8");
  if (error === null) {
    try {
      evidence = await verifyJourney(directory);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  manifest.journeys.push({
    ...journey,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: execution.code,
    signal: execution.signal,
    ok: error === null,
    error,
    evidence,
  });
  manifest.completedJourneys += 1;
  if (error) manifest.failedJourneys += 1;
  await writeManifest();
  if (error) {
    manifest.status = "failed";
    manifest.completedAt = new Date().toISOString();
    manifest.flakeRate = manifest.failedJourneys / manifest.completedJourneys;
    await writeManifest();
    throw new Error(`stability journey ${journey.cycle}/${journey.engine} failed: ${error}`);
  }
}

manifest.status = "passed";
manifest.completedAt = new Date().toISOString();
manifest.flakeRate = manifest.failedJourneys / manifest.completedJourneys;
await writeManifest();
console.log(JSON.stringify({ ok: true, artifactRoot, manifest }));
