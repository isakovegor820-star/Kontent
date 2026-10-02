import type { WebFinding, WebFindingRejectionCode } from "./web-research-contract.mjs";
import type { WebResearchBudget } from "./web-research-plan.d.mts";

export type WebResearchPlanQuery = {
  id: string;
  text: string;
  category: string;
  language: string;
  siteScoped: boolean;
  priority: number;
};

export type WebResearchResearchPlan = {
  topic: string;
  language: string;
  categories: string[];
  queries: WebResearchPlanQuery[];
  budget: WebResearchBudget;
  siteScopedCount: number;
  fingerprint: string;
};

export type WebResearchLogEntry = {
  step: "plan" | "search" | "select" | "read" | "extract" | "gate" | string;
  message: string;
  detail: Record<string, unknown> | null;
  at: string;
};

export type WebResearchPageCandidate = {
  url: string;
  domain: string | null;
  title: string;
  snippet: string;
  publishedAt: string | null;
  tier: "official" | "professional" | "research" | "media" | "open";
  trust: number;
  score: number;
  matchedQueries: string[];
};

export type WebResearchFindingDraft = {
  kind?: string;
  claim?: string;
  quote?: string;
  legalStatus?: string | null;
  publishedAt?: string | null;
  title?: string | null;
  language?: string | null;
};

export type WebResearchRunResult = {
  plan: WebResearchResearchPlan;
  findings: Array<WebFinding & { matchedQueries: string[]; candidateScore: number }>;
  rejections: Array<{
    url: string;
    domain: string | null;
    code: WebFindingRejectionCode | string;
    reason: string;
    detail?: Record<string, unknown> | null;
    claim?: string;
  }>;
  log: WebResearchLogEntry[];
  stats: {
    queries: number;
    pages: number;
    candidates: number;
    findings: number;
    rejections: number;
    spentMs: number;
    deadlineHit: boolean;
  };
};

export type WebResearchSearchResult = {
  url?: string;
  title?: string;
  snippet?: string;
  publishedAt?: string | null;
  provider?: string;
  matchedQueries?: string[];
};

export type WebResearchDeps = {
  search: (query: string, plan: WebResearchResearchPlan) => Promise<WebResearchSearchResult[]>;
  fetchPage: (url: string) => Promise<{ url?: string; text?: string; html?: string; contentType?: string; status?: number }>;
  extract: (input: { page: WebResearchPageCandidate; plan: WebResearchResearchPlan; pageText: string }) => Promise<WebResearchFindingDraft[]>;
  now?: number;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
};

export class WebResearchError extends Error {
  readonly code: "no_search" | "no_fetch" | "no_extract";
}

export const WEB_RESEARCH_LOG_LIMIT: number;

export function isReadableResearchUrl(value: unknown): boolean;
export function selectResearchPages(
  candidates: WebResearchSearchResult[],
  plan: WebResearchResearchPlan,
  options?: { maxPages?: number; perDomain?: number },
): WebResearchPageCandidate[];
export function runWebResearch(
  request: {
    topic?: string;
    categories?: string[];
    language?: "RU" | "EN" | "ANY";
    extraQueries?: string[];
    budget?: Partial<WebResearchBudget>;
  },
  deps: WebResearchDeps,
): Promise<WebResearchRunResult>;

export function summarizeWebResearchRun(run: Partial<WebResearchRunResult> | null | undefined): {
  queries: number;
  pages: number;
  candidates: number;
  findings: number;
  rejections: number;
  spentMs: number;
  deadlineHit: boolean;
  rejectionsByCode: Array<{ code: string; count: number; reason: string }>;
};
export function webFindingAngle(finding: Partial<WebFinding> | null | undefined): string;
