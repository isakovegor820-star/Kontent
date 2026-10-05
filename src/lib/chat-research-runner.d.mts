import type { WebFinding } from "./web-research-contract.mjs";
import type { WebSourceTier } from "./web-research-sources.d.mts";

export const CHAT_RESEARCH_BUDGET: Readonly<{
  maxQueries: number;
  maxPages: number;
  maxCandidates: number;
  maxResponseBytes: number;
  deadlineMs: number;
}>;
export const CHAT_RESEARCH_PASSAGES_PER_PAGE: number;

export type ChatResearchFinding = WebFinding & { title: string | null; dateKnown: boolean };

export type ChatResearchSource = {
  label: string;
  url: string;
  date: string | null;
  tier: string;
};

export type ChatResearchResult = {
  findings: ChatResearchFinding[];
  sources: ChatResearchSource[];
  queries: number;
  pages: number;
  rejectionCodes: string[];
};

export type ChatResearchHeader = {
  used: true;
  reason: string;
  queries: number;
  pages: number;
  findings: number;
  sources: ChatResearchSource[];
};

export function extractPublishedAt(html: unknown, now?: number, url?: string | null): string | null;
export function splitPassages(text: unknown): string[];
export function selectTopicPassages(text: unknown, topic: unknown, limit?: number): string[];

export type ChatResearchSearchDeps = {
  /** Поисковый провайдер: по умолчанию Радар с бесплатными web-адаптерами. */
  search?: (query: string) => Promise<Array<{ url: string; title: string; snippet: string; publishedAt: string | null }>>;
  /** Чтение страницы: по умолчанию SSRF-безопасный fetchPublicText. */
  readPage?: (url: string, timeoutMs?: number) => Promise<{ url: string; html: string }>;
  fetchImpl?: typeof fetch;
  fetchPage?: (url: string, options?: Record<string, unknown>) => Promise<{
    url?: string;
    headers?: Record<string, string>;
    text: () => Promise<string>;
  }>;
  searxngUrl?: string;
};

export function searchChatResearch(
  query: string,
  options?: ChatResearchSearchDeps,
): Promise<Array<{ url: string; title: string; snippet: string; publishedAt: string | null }>>;
export function readChatResearchPage(
  url: string,
  timeoutMs?: number,
  options?: ChatResearchSearchDeps,
): Promise<{ url: string; html: string }>;

export function runChatResearch(input: {
  topic: string;
  categories?: string[];
  language?: "RU" | "EN" | "ANY";
  kind?: string;
  now?: number;
  budget?: Partial<typeof CHAT_RESEARCH_BUDGET>;
}, deps?: ChatResearchSearchDeps): Promise<ChatResearchResult>;

export function chatResearchHeader(result: unknown, reason: string): ChatResearchHeader;
export function buildChatEvidenceBlock(findings: unknown, options?: { limit?: number }): string;

export type { WebSourceTier };
