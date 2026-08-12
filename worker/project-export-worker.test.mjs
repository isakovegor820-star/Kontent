import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ processProjectExportOperation: vi.fn() }));

vi.mock("../src/lib/project-export-operation.mjs", async () => {
  const actual = await vi.importActual("../src/lib/project-export-operation.mjs");
  return { ...actual, processProjectExportOperation: mocks.processProjectExportOperation };
});

import { UnrecoverableError } from "bullmq";
import { ProjectExportOperationError } from "../src/lib/project-export-operation.mjs";
import { createProjectExportWorker } from "./project-export-worker.mjs";

class FakeWorker {
  constructor(name, processor, options) {
    this.name = name;
    this.processor = processor;
    this.options = options;
    this.on = vi.fn();
  }
}

describe("project export worker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes the project-bound immutable identity and final-attempt state", async () => {
    mocks.processProjectExportOperation.mockResolvedValue({ outcome: "ready", artifactId: 3 });
    const pool = {};
    const worker = createProjectExportWorker({
      connection: { host: "localhost" },
      pool,
      WorkerClass: FakeWorker,
    });
    await worker.processor({
      data: { operationId: 41, projectId: 7, snapshotHash: "a".repeat(64) },
      attemptsMade: 2,
      opts: { attempts: 3 },
    });
    expect(worker.name).toBe("project-export");
    expect(mocks.processProjectExportOperation).toHaveBeenCalledWith({
      pool,
      operationId: 41,
      projectId: 7,
      snapshotHash: "a".repeat(64),
      finalAttempt: true,
    });
  });

  it("permanently rejects malformed and terminal jobs", async () => {
    const worker = createProjectExportWorker({ connection: {}, pool: {}, WorkerClass: FakeWorker });
    await expect(worker.processor({ data: {}, opts: {} })).rejects.toBeInstanceOf(UnrecoverableError);
    mocks.processProjectExportOperation.mockRejectedValue(
      new ProjectExportOperationError("export_snapshot_invalid", { retryable: false }),
    );
    await expect(worker.processor({
      data: { operationId: 41, projectId: 7, snapshotHash: "a".repeat(64) },
      attemptsMade: 0,
      opts: { attempts: 3 },
    })).rejects.toMatchObject({ name: "UnrecoverableError" });
  });

  it("keeps retryable rendering failures retryable", async () => {
    const retryable = new ProjectExportOperationError("export_render_failed", { retryable: true });
    mocks.processProjectExportOperation.mockRejectedValue(retryable);
    const worker = createProjectExportWorker({ connection: {}, pool: {}, WorkerClass: FakeWorker });
    await expect(worker.processor({
      data: { operationId: 41, projectId: 7, snapshotHash: "a".repeat(64) },
      attemptsMade: 0,
      opts: { attempts: 3 },
    })).rejects.toBe(retryable);
  });
});
