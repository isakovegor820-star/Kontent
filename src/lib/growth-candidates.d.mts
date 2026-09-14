import type { Pool, PoolClient } from "pg";
import type { GrowthSignals, GrowthMoveDraft, GrowthMoveKind, GrowthConfidence, GrowthEvidence } from "./growth";

export const GROWTH_TIME_ZONE: string;
export function moscowCalendarDate(now?: Date): string;
export function growthWeekStart(now?: Date): string;
export function significantTokens(text: string): Set<string>;
export function tokenOverlap(left: string, right: string): number;
export function coversTopic(posts: GrowthSignals["ownPosts30d"], text: string): boolean;
export function growthFingerprint(parts: Pick<GrowthMoveDraft, "kind" | "sourceKind" | "sourceId">): string;
export function goalFitForMove(goal: string | null, kind: GrowthMoveKind): number;
export function evidenceWeight(confidence: GrowthConfidence): number;
export function effortWeight(effort: GrowthEvidence["effort"]): number;
export function rankGrowthMoves(drafts: GrowthMoveDraft[], goal: string | null, limit?: number): GrowthMoveDraft[];
export function buildGrowthMoves(signals: GrowthSignals, limit?: number): GrowthMoveDraft[];
export function humanFreshness(value: string | Date, now?: Date): string;
export function loadSignals(db: Pick<Pool | PoolClient, "query">, scope: { projectId: number; channelId: number }): Promise<GrowthSignals>;
export function persistGrowthCandidates(db: Pick<Pool | PoolClient, "query">, scope: { projectId: number; channelId: number }, drafts: GrowthMoveDraft[], weekStart: string): Promise<void>;
