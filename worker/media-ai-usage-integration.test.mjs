import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const worker = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");
const mediaWorker = await readFile(
  new URL("./media-generation-worker.mjs", import.meta.url),
  "utf8",
);
const migration = await readFile(
  new URL("../db/migrations/20260801_media_ai_usage.sql", import.meta.url),
  "utf8",
);

describe("media AI usage integration", () => {
  it("binds each durable generation to a unique shared reservation", () => {
    expect(migration).toContain("ai_usage_reservation_id");
    expect(migration).toContain("media_generations_user_request_key_uniq");
  });

  it("commits only with the saved asset and releases on terminal failure", () => {
    expect(worker).toContain("commitWorkerAiUsage(");
    expect(worker).toContain("releaseWorkerAiUsage(");
    expect(worker).toContain("heartbeatWorkerAiUsage(");
    expect(mediaWorker).toContain("await deps.store.persistResult(generation, result.outputUrl, lease)");
    expect(mediaWorker).toContain("await deps.store.failAndRelease(generation, attemptError)");
    expect(mediaWorker).toContain("await deps.store.failByJobIdentity?.(job, claimError)");
  });

  it("resumes a persisted provider job instead of submitting a duplicate", () => {
    expect(mediaWorker).toContain('let providerJobId = String(generation.provider_job_id || "").trim()');
    expect(mediaWorker).toContain("if (!providerJobId)");
    expect(mediaWorker).toContain("await deps.store.markGenerating(generation, providerJobId)");
  });
});
