export type WebResearchBudget = {
  maxQueries: number;
  maxPages: number;
  maxCandidates: number;
  maxResponseBytes: number;
  deadlineMs: number;
};

export type WebResearchPlanQuery = {
  id: string;
  text: string;
  category: string;
  language: string;
  siteScoped: boolean;
  priority: number;
};

export type WebResearchPlan = {
  topic: string;
  language: string;
  categories: string[];
  queries: WebResearchPlanQuery[];
  budget: WebResearchBudget;
  siteScopedCount: number;
  fingerprint: string;
};

export const WEB_RESEARCH_BUDGET: Readonly<WebResearchBudget>;
export const WEB_RESEARCH_LIMITS: Readonly<{
  minQueries: number; maxQueries: number;
  minPages: number; maxPages: number;
  minCandidates: number; maxCandidates: number;
  minDeadlineMs: number; maxDeadlineMs: number;
}>;

export function webResearchKeywords(value: unknown, limit?: number): string[];
export function webResearchTopic(value: unknown, options?: { keywordLimit?: number }): string;
export function normalizeWebResearchBudget(input?: Partial<WebResearchBudget>): WebResearchBudget;
export function webResearchScopedDomains(category: string, language?: "RU" | "EN" | null): string[];
export function planWebResearch(
  input: {
    topic?: string;
    categories?: string[];
    language?: "RU" | "EN" | "ANY";
    extraQueries?: string[];
    budget?: Partial<WebResearchBudget>;
    includeScoped?: boolean;
  },
  options?: { keywordLimit?: number },
): WebResearchPlan;
export function webResearchPlanFingerprint(topic: unknown, categories: string[] | null | undefined, queryTexts: string[] | null | undefined): string;
export function scoreWebResearchCandidate(candidate: unknown, plan: Partial<WebResearchPlan> | null | undefined): number;
