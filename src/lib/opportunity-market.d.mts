import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;
export type ResearchProfile = {
  niche: string; audience: string; goal: string; taboo: string; rubrics: string[]; formats: string[];
  opportunityKeywords: string[]; excludedKeywords: string[]; language: string; region: string | null;
  searchText: string; terms: string[]; excludedTerms: string[]; hash: string;
};
export type MarketCandidate = {
  sourceKind: "market_signal" | "news_event" | "channel_profile"; sourceId: string; sourceLabel: string;
  title: string; summary: string; observedAt: string; type: string; priority: number; sourceCount: number;
  sources: Array<{ url: string; label: string; trust: number }>; relevance: number; momentum: number;
  freshness: number; trust: number; profileHash: string; publishBefore: string | null; expiresAt: string;
};
export function researchProfile(input?: Record<string, unknown>): ResearchProfile;
export function marketRelevance(profile: ResearchProfile, text: string): number;
export function opportunityTypeFor(sourceKind: string | null, publishedAt?: string | null, now?: Date): string;
export function opportunityWindow(type: string, observedAt?: string | Date | null, now?: Date): { expiresAt: Date; publishBefore: Date | null };
export function opportunityPriority(input: Record<string, number>): number;
export function freshnessScore(value?: string | Date | null, now?: Date): number;
export function syncPublicMarketSignals(db: Queryable): Promise<{ synchronized: number; skipped: boolean }>;
export function loadChannelMarketCandidates(db: Queryable, scope: { projectId: number; channelId: number }, profile: ResearchProfile, now?: Date): Promise<MarketCandidate[]>;
export function buildProfileFallbackCandidates(profile?: ResearchProfile | null, now?: Date): MarketCandidate[];

/**
 * Релевантность сигнала для канала. Проверенный факт из интернета получает нижний
 * порог, потому что отобран запросами по брифу канала и уже прошёл ворота достоверности.
 */
export function candidateRelevance(
  profile: ResearchProfile,
  title: string,
  summary: string,
  rawMetadata?: Record<string, unknown> | null,
): number;

/** Параметры рыночного сигнала, собранные из проверенного факта из интернета. */
export interface WebResearchSignalInput {
  key: string;
  kind: "news" | "rising_topic" | "evergreen_gap" | "public_post";
  title: string;
  summary: string;
  publishedAt: string;
  lastSeenAt: string;
  momentum: number;
  trust: number;
  provider: string;
  url: string;
  sourceTitle: string | null;
  rawMetadata: Record<string, unknown>;
}

export function webResearchSignalInput(row: {
  id: number | string;
  fingerprint: string;
  kind: string;
  claim: string;
  quote: string;
  legal_status: string | null;
  source_url: string;
  source_domain: string;
  source_label: string | null;
  source_tier: string;
  source_trust: number | string;
  corroboration_count: number | string;
  published_at: string;
  retrieved_at: string;
}): WebResearchSignalInput;

export function syncWebResearchSignals(
  db: Queryable, options?: { maxAgeDays?: number },
): Promise<{ synchronized: number; skipped: boolean }>;
