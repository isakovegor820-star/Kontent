export type WebSourceTier = "official" | "professional" | "research" | "media" | "open";
export type WebSourceCategory = "law" | "benchmark" | "market" | "technology" | "statistics" | "society";
export type WebSourceLanguage = "RU" | "EN";

export interface WebSourceEntry {
  domain: string;
  label: string;
  tier: WebSourceTier;
  categories: WebSourceCategory[];
  language: WebSourceLanguage;
  publisher: string | null;
  aliases?: string[];
}

export interface ResolvedWebSource {
  domain: string | null;
  tier: WebSourceTier;
  trust: number;
  label: string;
  registered: boolean;
  nonSource: boolean;
  entry: WebSourceEntry | null;
}

export const WEB_SOURCE_TIERS: readonly WebSourceTier[];
export const WEB_SOURCE_TIER_TRUST: Readonly<Record<WebSourceTier, number>>;
export const WEB_SOURCE_TIER_LABELS: Readonly<Record<WebSourceTier, string>>;
export const WEB_SOURCE_CATEGORIES: readonly WebSourceCategory[];
export const WEB_SOURCE_CATEGORY_LABELS: Readonly<Record<WebSourceCategory, string>>;
export const WEB_SOURCE_REGISTRY: readonly WebSourceEntry[];
export const WEB_RESEARCH_NON_SOURCE_HOSTS: readonly string[];
export const WEB_RESEARCH_OFFICIAL_TIERS: readonly WebSourceTier[];
export const WEB_RESEARCH_SOLE_SOURCE_TIERS: readonly WebSourceTier[];
export const WEB_RESEARCH_NUMERIC_TIERS: readonly WebSourceTier[];

export function normalizeWebDomain(value: unknown): string | null;
export function lookupWebSource(value: unknown): WebSourceEntry | null;
export function resolveWebSource(value: unknown): ResolvedWebSource;
export function webSourceDomainsForCategory(
  category: WebSourceCategory,
  options?: { tiers?: WebSourceTier[]; language?: WebSourceLanguage | null },
): string[];
export function webSourceCategories(entry: WebSourceEntry | null | undefined): WebSourceCategory[];
