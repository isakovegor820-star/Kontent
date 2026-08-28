export type TelegramCandidate = {
  handle: string;
  messageId: number | null;
  canonicalUrl: string;
  canonicalKey: string;
  provider?: string;
  correctedQuery?: string | null;
  matchedQueries?: string[];
  providers?: string[];
};
export type RadarWebCandidate = {
  canonicalUrl: string;
  canonicalKey: string;
  domain: string;
  title: string | null;
  snippet: string | null;
  publishedAt: string | null;
  provider: string;
  correctedQuery?: string | null;
  matchedQueries?: string[];
  providers?: string[];
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
export const RADAR_DISCOVERY_BUDGET: Readonly<{
  maxPages: number;
  maxCandidates: number;
  maxQueries: number;
  maxResponseBytes: number;
  deadlineMs: number;
}>;
export const RADAR_WEB_DISCOVERY_BUDGET: typeof RADAR_DISCOVERY_BUDGET;
export type TelegramDiscoveryResult = TelegramCandidate[] & {
  readonly status: "complete" | "partial";
  readonly partialReasons: string[];
  readonly budget: { pages: number; candidates: number; reasons: string[]; deadlineMs: number };
};
export class RadarDiscoveryError extends Error { code: string; }
export function normalizeRadarQuery(value: unknown): string;
export function radarIdentityHandle(value: unknown): string | null;
export function detectRadarQueryIntent(value: unknown): "identity" | "topic";
export function sanitizeRadarPublicText(value: unknown, maxLength?: number): string;
export function radarQueryTokens(value: unknown): string[];
export function radarTsQuery(value: unknown): string;
export function buildRadarDiscoveryQueries(query: unknown, expanded?: unknown[]): string[];
export function buildRadarWebDiscoveryQueries(query: unknown, expanded?: unknown[]): string[];
export function normalizeTelegramCandidate(rawUrl: unknown): TelegramCandidate | null;
export function parseTelegramCandidates(payload: unknown, provider?: string): TelegramCandidate[];
export function createSearxngTelegramProvider(options?: Record<string, unknown>): unknown;
export function createBraveHtmlTelegramProvider(options?: Record<string, unknown>): unknown;
export function createYahooHtmlTelegramProvider(options?: Record<string, unknown>): unknown;
export function createPublicHtmlTelegramProvider(options?: Record<string, unknown>): unknown;
export function createBingRssTelegramProvider(options?: Record<string, unknown>): unknown;
export function createDuckDuckGoTelegramProvider(options?: Record<string, unknown>): unknown;
export function normalizeRadarWebCandidate(rawUrl: unknown, metadata?: Record<string, unknown>): RadarWebCandidate | null;
export function parseBingRssWebCandidates(payload: unknown, provider?: string): RadarWebCandidate[];
export function parseBraveSearchCorrection(payload: unknown): string | null;
export function parseBraveWebCandidates(payload: unknown, provider?: string): RadarWebCandidate[];
export function parseYahooSearchCorrection(payload: unknown): string | null;
export function parseYahooWebCandidates(payload: unknown, provider?: string): RadarWebCandidate[];
export function parseDuckDuckGoWebCandidates(payload: unknown, provider?: string): RadarWebCandidate[];
export function createSearxngWebProvider(options?: Record<string, unknown>): unknown;
export function createBraveHtmlWebProvider(options?: Record<string, unknown>): unknown;
export function createYahooHtmlWebProvider(options?: Record<string, unknown>): unknown;
export function createPublicHtmlWebProvider(options?: Record<string, unknown>): unknown;
export function createBingRssWebProvider(options?: Record<string, unknown>): unknown;
export function createDuckDuckGoWebProvider(options?: Record<string, unknown>): unknown;
export function discoverRadarWebCandidates(query: unknown, options?: Record<string, unknown>): Promise<Array<RadarWebCandidate> & {
  readonly status: "complete" | "partial";
  readonly partialReasons: string[];
}>;
export function createRadarDiscoveryBudget(options?: Record<string, unknown>): unknown;
export function discoverTelegramCandidates(query: unknown, options?: Record<string, unknown>): Promise<TelegramDiscoveryResult>;
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
export function radarWebSourceKind(value: unknown): "social" | "reference" | "profile" | "article" | "organization" | "other";
export function rankRadarWebSource(query: unknown, source?: Record<string, unknown>): RadarRank & {
  sourceKind: string;
  exactIdentity: boolean;
  correctedIdentity: string | null;
};
export function parseRadarOsintProfile(raw: unknown, sourceCount: number): null | {
  displayName: string | null;
  bio: string | null;
  facts: Array<{ text: string; sourceIds: number[] }>;
  aliases: string[];
  ambiguities: string[];
  confidence: "low" | "medium" | "high";
};
export function median(values: unknown[]): number | null;
