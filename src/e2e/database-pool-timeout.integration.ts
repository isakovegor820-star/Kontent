import { execFile } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DatabasePoolSnapshot } from "@/lib/db-pool-monitor.mjs";

const run = promisify(execFile);
const TEST_ROLE = "aurora_pool_test";
const ACQUIRE_TIMEOUT_MS = 200;
const STATEMENT_TIMEOUT_MS = 250;
const IDLE_TRANSACTION_TIMEOUT_MS = 300;

let clusterRoot = "";
let clusterData = "";
let clusterStarted = false;
let pool: Pool;
let getDatabasePoolSnapshot: () => DatabasePoolSnapshot;

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  if (!address || typeof address === "string") throw new Error("unable to reserve PostgreSQL test port");
  return address.port;
}

async function command(name: string, args: string[]): Promise<void> {
  try {
    await run(name, args, { maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr || "").trim()
      : error instanceof Error ? error.message : String(error);
    throw new Error(`${name} failed${detail ? `: ${detail}` : ""}`);
  }
}

beforeAll(async () => {
  clusterRoot = await mkdtemp(join(tmpdir(), "aurora-db-pool-timeout-"));
  clusterData = join(clusterRoot, "data");
  const socketDirectory = join(clusterRoot, "socket");
  const serverLog = join(clusterRoot, "postgres.log");
  await mkdir(socketDirectory);
  await command("initdb", [
    "-D",
    clusterData,
    "--auth=trust",
    "--encoding=UTF8",
    "--no-locale",
    "--no-sync",
    `--username=${TEST_ROLE}`,
  ]);
  const port = await reservePort();
  await command("pg_ctl", [
    "-D",
    clusterData,
    "-l",
    serverLog,
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`,
    "-w",
    "start",
  ]);
  clusterStarted = true;

  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", `postgresql://${TEST_ROLE}@127.0.0.1:${port}/postgres`);
  vi.stubEnv("AURORA_RUNTIME_ROLE", "web");
  vi.stubEnv("AURORA_DB_POOL_MAX_WEB", "1");
  vi.stubEnv("AURORA_DB_CONNECTION_TIMEOUT_MS", String(ACQUIRE_TIMEOUT_MS));
  vi.stubEnv("AURORA_DB_QUERY_TIMEOUT_MS", "1000");
  vi.stubEnv("AURORA_DB_STATEMENT_TIMEOUT_MS", String(STATEMENT_TIMEOUT_MS));
  vi.stubEnv("AURORA_DB_IDLE_TRANSACTION_TIMEOUT_MS", String(IDLE_TRANSACTION_TIMEOUT_MS));

  const database = await import("@/lib/db");
  pool = database.getPool();
  getDatabasePoolSnapshot = database.getDatabasePoolSnapshot;
}, 30_000);

afterAll(async () => {
  if (pool) await pool.end();
  if (clusterStarted) {
    await command("pg_ctl", ["-D", clusterData, "-m", "fast", "-w", "stop"]);
  }
  vi.unstubAllEnvs();
  if (clusterRoot) process.stderr.write(`database-pool-timeout evidence retained at ${clusterRoot}\n`);
}, 30_000);

describe("database pool timeout integration", () => {
  it("times out a second acquisition and reports it without error details", async () => {
    const held = await pool.connect();
    const startedAt = performance.now();
    let failure: unknown;
    try {
      await pool.connect();
    } catch (error) {
      failure = error;
    } finally {
      held.release();
    }
    const elapsedMs = performance.now() - startedAt;

    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/timeout exceeded when trying to connect/iu);
    expect(elapsedMs).toBeGreaterThanOrEqual(ACQUIRE_TIMEOUT_MS - 25);
    expect(elapsedMs).toBeLessThan(2_000);
    const snapshot = getDatabasePoolSnapshot();
    expect(snapshot).toMatchObject({
      role: "web",
      max: 1,
      acquireTimeouts: 1,
      acquireErrors: 1,
      connectionTimeoutMillis: ACQUIRE_TIMEOUT_MS,
      statementTimeoutMillis: STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMillis: IDLE_TRANSACTION_TIMEOUT_MS,
    });
    expect(snapshot.acquireWaitP95Ms).toBeGreaterThanOrEqual(ACQUIRE_TIMEOUT_MS - 25);
    expect(JSON.stringify(snapshot)).not.toContain((failure as Error).message);
  });

  it("cancels a slow statement at the configured server boundary and recovers", async () => {
    const startedAt = performance.now();
    let failure: unknown;
    try {
      await pool.query("select pg_sleep(1)");
    } catch (error) {
      failure = error;
    }
    const elapsedMs = performance.now() - startedAt;

    expect(failure).toMatchObject({ code: "57014" });
    expect(String((failure as Error).message)).toMatch(/statement timeout/iu);
    expect(elapsedMs).toBeGreaterThanOrEqual(STATEMENT_TIMEOUT_MS - 25);
    expect(elapsedMs).toBeLessThan(2_000);
    await expect(pool.query("select 1 as ok")).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });

  it("terminates an idle transaction and replaces the unusable connection", async () => {
    const client: PoolClient = await pool.connect();
    const termination = new Promise<Error>((resolveError) => client.once("error", resolveError));
    await client.query("begin");
    const failure = await Promise.race([
      termination,
      new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), 2_000)),
    ]);
    client.release(true);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: "25P03" });
    expect(String(failure?.message)).toMatch(/idle-in-transaction timeout/iu);
    await expect(pool.query("select 1 as ok")).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });
});
