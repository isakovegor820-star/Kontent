export type SiteCrawlStage = "robots" | "sitemap" | "crawling" | "analyzing" | "planning" | "ready";

export type SiteCrawlLimits = {
  maxPages: number;
  maxPageBytes: number;
  maxTotalBytes: number;
  maxRedirects: number;
  timeoutMs: number;
  maxSitemaps: number;
  maxSitemapUrls: number;
};

export class SiteCrawlerError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export const SITE_ANALYSIS_POLICY_VERSION: string;
export const SITE_CRAWLER_USER_AGENT: string;
export const DEFAULT_SITE_CRAWL_LIMITS: Readonly<SiteCrawlLimits>;
export function normalizeSiteLimits(value?: Partial<SiteCrawlLimits>): Readonly<SiteCrawlLimits>;
export function upgradeLegacySiteLimits(value?: Partial<SiteCrawlLimits>): Readonly<SiteCrawlLimits>;
export function normalizeSiteTarget(value: unknown, confirmedDomain: unknown, consent: unknown): URL;
export function parseRobotsTxt(text: unknown, userAgent?: string): Readonly<{ userAgent: string; rules: Array<{ type: "allow" | "disallow"; pattern: string }>; sitemaps: string[] }>;
export function robotsAllows(policy: { rules?: Array<{ type: string; pattern: string }> }, value: URL | string): boolean;
export function extractSitemapUrls(xml: unknown, baseUrl: URL | string, maxUrls?: number): string[];
export function extractSitemapDocument(xml: unknown, baseUrl: URL | string, maxUrls?: number): Readonly<{ kind: "index" | "urlset"; urls: string[] }>;
export function stratifySitemapUrls(values: string[], maxUrls?: number): string[];
export function extractSitePage(html: unknown, value: URL | string, status?: number): Record<string, unknown>;
export function buildSiteAnalysisReport(targetUrl: URL | string, pages: Array<Record<string, unknown>>, limits?: SiteCrawlLimits): Record<string, unknown>;
export function crawlSite(
  input: { targetUrl: unknown; confirmedDomain: unknown; consent: unknown; limits?: Partial<SiteCrawlLimits> },
  dependencies?: { fetchText?: (url: string, options: Record<string, unknown>) => Promise<unknown>; onProgress?: (event: { stage: SiteCrawlStage; progress: number; detail: string }) => unknown },
): Promise<{ report: Record<string, unknown>; pages: Array<Record<string, unknown>>; totalBytes: number; robots: { sitemaps: string[] } }>;
