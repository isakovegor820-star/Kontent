import { describe, expect, it, vi } from "vitest";

import {
  productDurationMs,
  recordServerProductEvent,
  safeProductErrorCode,
} from "./server-product-events.mjs";

function fakePool(behaviour = {}) {
  const query = vi.fn(async (sql) => {
    if (behaviour.failOn && String(sql).includes(behaviour.failOn)) throw new Error("postgresql://user:secret@host/db");
    if (String(sql).includes("insert into product_events")) return { rowCount: behaviour.duplicate ? 0 : 1, rows: [{ id: 1 }] };
    return { rowCount: 1, rows: [] };
  });
  const release = vi.fn();
  return { pool: { connect: vi.fn(async () => ({ query, release })) }, query, release };
}

const base = {
  userId: 7,
  projectId: 3,
  sectionId: "calendar",
  featureId: "publication",
  action: "scheduled",
  stage: "accepted",
  outcome: "success",
  source: "api",
  operationKind: "interactive_api",
  requestId: "req-1",
  operationId: "post:42",
  durationMs: 120,
};
const release = { release: "2026.09.02-abc", commitSha: "abc", deployedAt: null };

describe("server-side product events", () => {
  it("stores a validated event with server-owned tenant identity inside one transaction", async () => {
    const { pool, query, release: releaseClient } = fakePool();
    const logger = { error: vi.fn() };
    await expect(recordServerProductEvent(pool, base, { release, logger })).resolves.toBe(true);
    const statements = query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/u)[0]);
    expect(statements[0]).toBe("begin");
    expect(statements.at(-1)).toBe("commit");
    const insert = query.mock.calls.find(([sql]) => String(sql).includes("insert into product_events"));
    expect(insert[1]).toEqual(expect.arrayContaining([3, 7, "calendar", "publication", "scheduled", "accepted", "success", 120, "req-1", "post:42", "2026.09.02-abc"]));
    expect(JSON.parse(insert[1][15])).toEqual({ device: "unknown", source: "api", operationKind: "interactive_api" });
    expect(releaseClient).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("rejects contract violations before touching the database and logs only safe fields", async () => {
    const { pool, query } = fakePool();
    const logger = { error: vi.fn() };
    await expect(recordServerProductEvent(pool, { ...base, action: "exploded" }, { release, logger })).resolves.toBe(false);
    await expect(recordServerProductEvent(pool, { ...base, stage: "failed", outcome: "failure", errorCode: null }, { release, logger })).resolves.toBe(false);
    await expect(recordServerProductEvent(pool, { ...base, projectId: 0 }, { release, logger })).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret");
  });

  it("never throws into the domain path when the store fails", async () => {
    const { pool, query } = fakePool({ failOn: "insert into product_events" });
    const logger = { error: vi.fn() };
    await expect(recordServerProductEvent(pool, base, { release, logger })).resolves.toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql) === "rollback")).toBe(true);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("postgresql://");
    expect(logger.error.mock.calls[0][1]).toMatchObject({ code: "product_event_store_unavailable" });
  });

  it("carries queue/attempt context for worker events", async () => {
    const { pool, query } = fakePool();
    await recordServerProductEvent(pool, {
      ...base,
      source: "worker",
      operationKind: "worker_execution",
      stage: "failed",
      outcome: "failure",
      errorCode: "provider_error",
      queue: "publish",
      attempt: 2,
    }, { release, logger: { error: vi.fn() } });
    const insert = query.mock.calls.find(([sql]) => String(sql).includes("insert into product_events"));
    expect(JSON.parse(insert[1][15])).toEqual({ device: "unknown", source: "worker", operationKind: "worker_execution", queue: "publish", attempt: 2 });
  });

  it("sanitises error codes and bounds durations", () => {
    expect(safeProductErrorCode("Telegram: Bad Request", "provider_error")).toBe("provider_error");
    expect(safeProductErrorCode("https://evil.example/?token=1", "provider_error")).toBe("provider_error");
    expect(safeProductErrorCode("topic:off_topic", "x")).toBe("topic_off_topic");
    expect(safeProductErrorCode("Provider-Rate.Limited", "x")).toBe("provider_rate_limited");
    expect(safeProductErrorCode(null, "provider_error")).toBe("provider_error");
    expect(safeProductErrorCode("vk_token_expired", "x")).toBe("vk_token_expired");
    expect(productDurationMs(1_000, 1_250)).toBe(250);
    expect(productDurationMs(2_000, 1_000)).toBeNull();
    expect(productDurationMs(Number.NaN, 1_000)).toBeNull();
  });
});
