export type SiteArticleType =
  | "company_news"
  | "industry_explainer"
  | "audience_answer"
  | "evergreen_guide"
  | "case_study"
  | "machine_readable_page";
export type SiteArticleOrigin = "rss" | "channel_post" | "audience_question" | "gap" | "manual";

export const SITE_ARTICLE_TYPES: Readonly<Record<SiteArticleType, Readonly<{ id: SiteArticleType; label: string; minWords: number; maxWords: number; requires: readonly string[] }>>>;
export const SITE_ARTICLE_TYPE_IDS: readonly SiteArticleType[];
export const SITE_ARTICLE_ORIGINS: readonly SiteArticleOrigin[];

export type SiteCadence = Readonly<{
  weekly: Readonly<Record<SiteArticleType, number>>;
  sharedPools: ReadonlyArray<Readonly<{ types: SiteArticleType[]; limit: number }>>;
  maxPendingReview: number;
}>;
export const DEFAULT_SITE_CADENCE: SiteCadence;
export function normalizeSiteCadence(raw?: unknown): SiteCadence;
export function remainingQuota(cadence: unknown, createdThisWeekByType?: Record<string, number>): Record<SiteArticleType, number>;
export function selectArticleType(input: { origin: SiteArticleOrigin; source?: Record<string, unknown>; profile?: Record<string, unknown> }): SiteArticleType | null;
export function sourceKeyFor(origin: SiteArticleOrigin, source: Record<string, unknown>): string | null;
export function planArticleCandidates(input: Record<string, unknown>): Array<{ origin: SiteArticleOrigin; type: SiteArticleType; source: Record<string, unknown>; sourceKey: string | null; priority: number }>;
