export type TelegramCandidate = {
  handle: string;
  messageId: number | null;
  canonicalUrl: string;
  canonicalKey: string;
  provider?: string;
};

export type RadarRank = {
  score: number;
  relevance: number;
  freshness: number;
  accepted: boolean;
  reason: string;
  activity?: number;
  trust?: number;
  completeness?: number;
  penalty?: number;
  relevantPostCount?: number;
  lexicalRelevance?: number;
  semanticRelevance?: number;
};

export const RADAR_SEARCH_CACHE_MS: number;
export const RADAR_SEARCH_RESULT_LIMIT: number;
export const RADAR_SEARCH_CANDIDATE_LIMIT: number;
export const RADAR_SEARCH_QUERY_LIMIT: number;
export class RadarDiscoveryError extends Error { code: string; }
export function normalizeRadarQuery(value: unknown): string;
export function radarQueryTokens(value: unknown): string[];
export function radarTsQuery(value: unknown): string;
export function buildRadarDiscoveryQueries(query: unknown, expanded?: unknown[]): string[];
export function normalizeTelegramCandidate(rawUrl: unknown): TelegramCandidate | null;
export function parseTelegramCandidates(payload: unknown, provider?: string): TelegramCandidate[];
export function createSearxngTelegramProvider(options?: Record<string, unknown>): unknown;
export function createBingRssTelegramProvider(options?: Record<string, unknown>): unknown;
export function createDuckDuckGoTelegramProvider(options?: Record<string, unknown>): unknown;
export function discoverTelegramCandidates(query: unknown, options?: Record<string, unknown>): Promise<TelegramCandidate[]>;
export function scoreRadarRelevance(query: unknown, input?: Record<string, unknown>): number;
export function scoreRadarSemanticSimilarity(value: unknown): number;
export function scoreRadarFreshness(value: unknown, now?: number): number;
export function scoreRadarActivity(postsPerWeek: unknown): number;
export function radarSpamPenalty(query: unknown, input?: Record<string, unknown>): number;
export function rankVerifiedTelegramSource(query: unknown, source: Record<string, unknown>, now?: number): RadarRank;
export function rankVerifiedTelegramSourceAcrossQueries(
  query: unknown,
  expandedQueries: unknown[],
  source: Record<string, unknown>,
  now?: number,
): RadarRank & { matchedQuery: string };
export function rankVerifiedTelegramPost(query: unknown, post: Record<string, unknown>, channelRank: RadarRank, now?: number): RadarRank;
export function median(values: unknown[]): number | null;
