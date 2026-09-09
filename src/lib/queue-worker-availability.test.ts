import { describe, expect, it, vi } from "vitest";
import { hasMediaWorker, hasAutopilotWorker } from "./queue";
import { hasSiteAnalysisWorker } from "./site-analysis-queue";
import { hasSiteArticlesWorker } from "./site-articles-queue";
import { hasProjectExportWorker } from "./project-export-queue.mjs";
import { hasLegalVisualRenderWorker } from "./legal-visual-render-queue.mjs";

const probes = [hasMediaWorker, hasAutopilotWorker, hasSiteAnalysisWorker, hasSiteArticlesWorker, hasProjectExportWorker, hasLegalVisualRenderWorker];
const queue = (workers: unknown[], db: unknown = 12) => ({
  client: Promise.resolve({ options: { db } }),
  getWorkers: vi.fn(async () => workers),
  // Preserve BullMQ's actual server-global count behavior as a defect control.
  getWorkersCount: vi.fn(async () => workers.length),
});

describe.each(probes)("database-scoped worker availability %s", (probe) => {
  it("rejects a same-name worker in another DB, and accepts a worker in its own DB", async () => {
    await expect(probe(queue([{ db: "13" }]) as never, 25)).resolves.toBe(false);
    await expect(probe(queue([{ db: "13" }, { db: "12" }]) as never, 25)).resolves.toBe(true);
    await expect(probe(queue([]) as never, 25)).resolves.toBe(false);
    await expect(probe(queue([{ db: "0" }], 0) as never, 25)).resolves.toBe(true);
  });

  it.each([undefined, null, "", "invalid", "-1", "1.5", -1, NaN])("rejects missing or malformed worker database %s", async (db) => {
    await expect(probe(queue([{ db }, { db: "12" }]) as never, 25)).resolves.toBe(false);
  });

  it.each([null, "", "invalid", -1, NaN])("rejects an unknown selected connection database %s", async (db) => {
    await expect(probe(queue([{ db: "12" }], db) as never, 25)).resolves.toBe(false);
  });

  it("rejects a connection with no selected database metadata", async () => {
    await expect(probe({ ...queue([{ db: "12" }]), client: Promise.resolve({ options: {} }) } as never, 25)).resolves.toBe(false);
  });

  it("keeps the deadline when worker metadata or the connection never becomes available", async () => {
    const pending = new Promise<never>(() => {});
    await expect(probe({ ...queue([{ db: "12" }]), getWorkers: () => pending } as never, 5)).resolves.toBe(false);
    await expect(probe({ ...queue([{ db: "12" }]), client: pending } as never, 5)).resolves.toBe(false);
  });

  it("uses one deadline across connection discovery and the worker read", async () => {
    vi.useFakeTimers();
    try {
      const client = new Promise(resolve => setTimeout(() => resolve({ options: { db: 12 } }), 4));
      const getWorkers = vi.fn(() => new Promise(resolve => setTimeout(() => resolve([{ db: "12" }]), 4)));
      const result = probe({ ...queue([]), client, getWorkers } as never, 5);
      await vi.advanceTimersByTimeAsync(5);
      await expect(result).resolves.toBe(false);
      expect(getWorkers).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3);
      await expect(result).resolves.toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("fails closed on malformed lists and read errors", async () => {
    await expect(probe({ ...queue([]), getWorkers: async () => null } as never, 25)).resolves.toBe(false);
    await expect(probe({ ...queue([]), getWorkers: async () => { throw new Error("redis unavailable"); } } as never, 25)).resolves.toBe(false);
  });
});
