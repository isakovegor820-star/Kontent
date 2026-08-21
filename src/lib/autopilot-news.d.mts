export interface AutopilotNewsSource {
  id: string;
  title: string;
  url: string;
  category: string | null;
  language: "RU" | "EN";
  score: number;
  reason: string | null;
}

export interface AutopilotNewsCandidate {
  id: string;
  kind: "news";
  title: string;
  text: string;
  url: string;
  sourceId: string;
  sourceTitle: string;
  sourceCategory: string | null;
  sourceReason: string | null;
  publishedAt: string;
  score: number;
}

export const AUTOPILOT_NEWS_MAX_AGE_DAYS: number;
export const AUTOPILOT_NEWS_SOURCE_LIMIT: number;
export const AUTOPILOT_NEWS_CANDIDATE_LIMIT: number;
export function normalizeAutopilotNewsSources(value: unknown, limit?: number): AutopilotNewsSource[];
export function buildAutopilotNewsCandidates(
  sourceResults: unknown,
  options?: { context?: string; now?: number; maxAgeDays?: number; limit?: number },
): AutopilotNewsCandidate[];
export function autopilotNewsEvidence(candidate: unknown): {
  id: string;
  text: string;
  kind: "news";
  title: string;
  url: string;
  publishedAt: string;
} | null;
export function appendAutopilotSourceFooter(
  text: unknown,
  sources: unknown,
  maxChars?: number,
): string;
