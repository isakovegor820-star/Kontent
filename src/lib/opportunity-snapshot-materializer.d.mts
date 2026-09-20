import type { GrowthMoveRecord } from "./growth";
import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export const OPPORTUNITY_FORMULA_VERSION: "opportunity-market-v2";
export function normalizeTopicKey(value: string): string;
export function baselineCoverage(topic: string, ownPostTexts: string[]): number;
export function opportunityFingerprint(move: Pick<GrowthMoveRecord, "fingerprint" | "weekStart" | "reason" | "evidence">): string;
export function opportunityConfidence(move: Pick<GrowthMoveRecord, "confidence" | "evidence">): "low" | "medium" | "high";
export function opportunityExpiry(observedAt: string | null, now?: Date, type?: string): Date;
export function materializeOpportunitySnapshots(
  db: Queryable,
  scope: { projectId: number; channelId: number },
  moves: GrowthMoveRecord[],
): Promise<{ candidates: number; inserted: number }>;
export function materializeAllOpportunitySnapshots(
  db: Pool,
): Promise<{ channels: number; inserted: number; failed: number }>;
