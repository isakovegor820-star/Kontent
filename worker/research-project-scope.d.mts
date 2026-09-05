import type { Pool, PoolClient } from "pg";
export type ResearchWorkerScope = { userId: number; projectId: number; channelId: number | null };
export class ResearchProjectAccessError extends Error {}
export function requireResearchWorkerScope(db: Pick<PoolClient, "query">, userId: number,
  channelId: number | null, expectedProjectId?: number | null): Promise<ResearchWorkerScope>;
export function requireRadarWorkerScope(db: Pick<PoolClient, "query">, runId: number,
  userId: number): Promise<ResearchWorkerScope>;
export function withResearchWorkerWrite<T>(pool: Pool, scope: ResearchWorkerScope,
  action: (client: PoolClient) => Promise<T>, options?: { channelLock?: "share" | "update" }): Promise<T>;
