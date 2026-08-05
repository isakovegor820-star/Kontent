import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import { completeAiText } from "@/lib/ai-completion-service.mjs";
import { orchestrateText } from "@/lib/ai-orchestrator";
import {
  acquireAiUsageRequest,
  aiRequestFingerprint,
  commitAiUsage,
  commitAiUsageResult,
  releaseAiUsage,
  releaseAiUsageRequest,
  reserveAiUsage,
} from "@/lib/ai-usage";
import { migrate } from "../../scripts/migrate.mjs";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
  || target.pathname.slice(1) !== "aurora_ai_gate_test") {
  throw new Error("Gate 4 integration requires disposable local aurora_ai_gate_test database");
}

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 8 });
let userId = 0;
let mode: "success" | "primary-timeout" | "all-fail" | "truncated" = "success";
const requests: Array<{ model?: string; messages?: Array<{ role?: string; content?: string }>; stream?: boolean }> = [];

async function jsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function openAiSuccess(response: ServerResponse, body: { stream?: boolean }) {
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"RESULT"}}]}\n\ndata: [DONE]\n\n');
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: "RESULT" }, finish_reason: "stop" }],
    }));
  }
}

const provider = createServer(async (request, response) => {
  const body = await jsonBody(request);
  requests.push(body);
  const primary = body.model === "deepseek-v4-pro";
  if (mode === "all-fail") {
    response.writeHead(503);
    response.end("unavailable");
    return;
  }
  if (mode === "truncated") {
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"choices":[{"delta":{"content":"PARTIAL"}}]}\n\n');
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "PARTIAL" }, finish_reason: null }],
      }));
    }
    return;
  }
  if (mode === "primary-timeout" && primary) {
    setTimeout(() => openAiSuccess(response, body), 250);
    return;
  }
  openAiSuccess(response, body);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("fake provider did not bind");
  process.env.NAVYAI_API_KEY = "disposable-test-key";
  process.env.NAVYAI_API_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.AI_FALLBACK_ENGINES = "navy-deepseek-flash";

  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
  userId = Number((await pool.query(
    "insert into users (email, name, ai_engine) values ('qa-ai-gate@example.test', 'QA AI Gate', 'navy-deepseek-pro') returning id",
  )).rows[0].id);
});

afterAll(async () => {
  await pool.end();
  await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
});

describe("Gate 4 common AI orchestration on disposable infrastructure", () => {
  it("delivers all five audit briefs to the configured provider with one committed reservation each", async () => {
    mode = "success";
    requests.length = 0;
    const briefs = [
      "Анонс мероприятия с точной датой и ссылкой",
      "Юридический разбор без неподтверждённых выводов",
      "Короткий вовлекающий пост без риторического клише",
      "Продуктовый пост без выдуманных преимуществ",
      "Длинный пост на основе двух явно указанных фактов",
    ];
    for (const [index, brief] of briefs.entries()) {
      const reservation = await reserveAiUsage(userId, "gate4-brief", {
        reservationKey: `gate4:brief:${index}`,
        limit: 30,
      }, pool);
      expect(reservation.allowed).toBe(true);
      const completed = await completeAiText({
        system: "Return the requested draft.",
        user: brief,
        engine: "navy-deepseek-pro",
      }, { env: process.env });
      expect(completed.text).toBe("RESULT");
      await expect(commitAiUsage(userId, reservation.reservationId, pool)).resolves.toBe(true);
    }
    expect(requests).toHaveLength(5);
    expect(requests.map((body) => body.messages?.at(-1)?.content)).toEqual(briefs);
    const usage = await pool.query(
      "select status, count(*)::int as count from ai_usage where user_id = $1 group by status",
      [userId],
    );
    expect(usage.rows).toEqual([{ status: "committed", count: 5 }]);
  });

  it("uses the same Navy primary/fallback policy for direct and streamed surfaces", async () => {
    mode = "primary-timeout";
    const direct = await completeAiText({
      system: "SYSTEM",
      user: "DIRECT",
      engine: "navy-deepseek-pro",
    }, { env: process.env, timeoutMs: 100 });
    expect(direct).toMatchObject({ engine: "navy-deepseek-flash", fallbackUsed: true, attempts: 2 });

    const events = [];
    for await (const event of orchestrateText({ kind: "write", task: "STREAM" }, "navy-deepseek-pro", {
      firstTokenMs: 100,
      overallMs: 2_000,
      fallbackEngines: ["navy-deepseek-flash"],
      circuitBreaker: null,
    })) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({
      type: "fallback",
      fromEngine: "navy-deepseek-pro",
      toEngine: "navy-deepseek-flash",
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: "delta", engine: "navy-deepseek-flash" }));
  });

  it("refunds one reservation after all providers fail and does not duplicate the charge", async () => {
    mode = "all-fail";
    const reservation = await reserveAiUsage(userId, "gate4-failure", {
      reservationKey: "gate4:all-fail",
      limit: 30,
    }, pool);
    await expect(completeAiText({
      system: "SYSTEM",
      user: "FAIL",
      engine: "navy-deepseek-pro",
    }, { env: process.env, timeoutMs: 500 })).rejects.toMatchObject({ code: "provider_error" });
    await expect(releaseAiUsage(userId, reservation.reservationId, pool)).resolves.toBe(true);
    await expect(releaseAiUsage(userId, reservation.reservationId, pool)).resolves.toBe(false);
    const row = await pool.query("select status from ai_usage where id = $1", [reservation.reservationId]);
    expect(row.rows[0].status).toBe("released");
  });

  it("rejects provider EOF without terminal marker", async () => {
    mode = "truncated";
    const fingerprint = aiRequestFingerprint({ command: "write", input: "TRUNCATE" });
    const operationId = "55555555-5555-4555-8555-555555555555";
    const reservation = await acquireAiUsageRequest(userId, "gate4-truncated", {
      reservationKey: "gate4:truncated:terminal",
      fingerprint,
      operationId,
      limit: 30,
    }, pool);
    expect(reservation).toMatchObject({ allowed: true, requestState: "acquired", status: "reserved" });

    await expect(completeAiText({
      system: "SYSTEM",
      user: "TRUNCATE",
      engine: "navy-deepseek-pro",
    }, { env: process.env, timeoutMs: 500 })).rejects.toMatchObject({ code: "stream_truncated" });

    await expect(releaseAiUsageRequest(
      userId,
      reservation.reservationId,
      operationId,
      pool,
    )).resolves.toBe(true);
    const row = await pool.query(
      "select status, result_payload from ai_usage where id = $1",
      [reservation.reservationId],
    );
    expect(row.rows[0]).toMatchObject({ status: "released", result_payload: null });

    const retry = await acquireAiUsageRequest(userId, "gate4-truncated", {
      reservationKey: "gate4:truncated:terminal",
      fingerprint,
      operationId: "66666666-6666-4666-8666-666666666666",
      limit: 30,
    }, pool);
    expect(retry).toMatchObject({ allowed: true, requestState: "acquired" });
    await releaseAiUsageRequest(
      userId,
      retry.reservationId,
      "66666666-6666-4666-8666-666666666666",
      pool,
    );
  });

  it("atomically commits one terminal chat result and replays it without a second provider call", async () => {
    mode = "success";
    const callsBefore = requests.length;
    const requestIdentity = { command: "write", input: "DURABLE REPLAY", surface: "studio" };
    const fingerprint = aiRequestFingerprint(requestIdentity);
    const operationId = "77777777-7777-4777-8777-777777777777";
    const reservation = await acquireAiUsageRequest(userId, "gate4-replay", {
      reservationKey: "gate4:durable:replay",
      fingerprint,
      operationId,
      limit: 30,
    }, pool);
    expect(reservation).toMatchObject({ allowed: true, requestState: "acquired" });

    const completed = await completeAiText({
      system: "SYSTEM",
      user: "DURABLE REPLAY",
      engine: "navy-deepseek-pro",
    }, { env: process.env, timeoutMs: 500 });
    const terminalResult = {
      protocol: "ndjson" as const,
      text: completed.text,
      pipeline: "single" as const,
      requestedEngine: "navy-deepseek-pro",
      engine: completed.engine,
      fallbackUsed: completed.fallbackUsed,
      validation: {
        status: "not_checked" as const,
        requiresReview: true,
        provenance: {},
        blockerCodes: [],
      },
    };
    await expect(commitAiUsageResult(
      userId,
      reservation.reservationId,
      operationId,
      terminalResult,
      pool,
    )).resolves.toMatchObject({ changed: true, status: "committed", result: terminalResult });

    const replay = await acquireAiUsageRequest(userId, "gate4-replay", {
      reservationKey: "gate4:durable:replay",
      fingerprint,
      operationId: "88888888-8888-4888-8888-888888888888",
      limit: 30,
    }, pool);
    expect(replay).toMatchObject({
      allowed: false,
      requestState: "replay",
      reservationId: reservation.reservationId,
      result: terminalResult,
    });
    expect(requests).toHaveLength(callsBefore + 1);
  });

  it("cancel from one tab releases only its own reservation", async () => {
    mode = "success";
    const first = await reserveAiUsage(userId, "gate4-tab", {
      reservationKey: "gate4:tab:first",
      limit: 30,
    }, pool);
    const second = await reserveAiUsage(userId, "gate4-tab", {
      reservationKey: "gate4:tab:second",
      limit: 30,
    }, pool);
    await releaseAiUsage(userId, first.reservationId, pool);
    const rows = await pool.query(
      "select id, status from ai_usage where id = any($1::bigint[]) order by id",
      [[first.reservationId, second.reservationId]],
    );
    expect(rows.rows.map((row) => row.status)).toEqual(["released", "reserved"]);
    await releaseAiUsage(userId, second.reservationId, pool);
  });

  it("serializes parallel requests at the final limit slot", async () => {
    const isolatedUser = Number((await pool.query(
      "insert into users (email, name) values ('qa-ai-limit@example.test', 'QA AI Limit') returning id",
    )).rows[0].id);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => reserveAiUsage(
      isolatedUser,
      "gate4-limit",
      { reservationKey: `gate4:limit:${index}`, limit: 1 },
      pool,
    )));
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect((await pool.query(
      "select count(*)::int as count from ai_usage where user_id = $1 and status = 'reserved'",
      [isolatedUser],
    )).rows[0].count).toBe(1);
  });
});
