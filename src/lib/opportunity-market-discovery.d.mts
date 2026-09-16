import type { Pool, PoolClient } from "pg";
import type { Queue } from "bullmq";

export function buildOpportunityDiscoveryQueries(profile: {
  niche?: unknown;
  rubrics?: unknown;
  keywords?: unknown;
}): Array<{ family: "current" | "rising" | "needs"; query: string }>;

export function refreshOpportunityMarket(
  db: Pick<Pool | PoolClient, "query">,
  queue: Pick<Queue, "add"> | null,
  now?: Date,
): Promise<{ synchronized: number; skipped: boolean; scheduled: number; queueUnavailable: boolean }>;
