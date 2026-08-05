import type { SiteInterviewQuestionData } from "./questions.data.mjs";

export const SITE_OSINT_PROMPT_VERSION: string;
export const SITE_OSINT_REPORT_VERSION: string;
export const SITE_OSINT_SYSTEM_PROMPT: string;
export function siteInterviewSemanticKey(input: Record<string, unknown>): string;
export function siteInterviewProviderKey(input: Record<string, unknown>): string;
export function createSiteInterviewBatches(questions?: readonly SiteInterviewQuestionData[], maxQuestions?: number): readonly Readonly<{ id: string; questions: readonly SiteInterviewQuestionData[] }>[];
export function buildSiteInterviewPrompt(input: Record<string, unknown>): Readonly<{
  system: string;
  user: string;
  evidenceIds: readonly string[];
  entityIds: readonly string[];
  sourceIds: readonly string[];
}>;
export function parseAndValidateSiteInterviewBatch(rawText: unknown, input: Record<string, unknown>): Readonly<Record<string, unknown>>;
export function aggregateSiteInterviewReport(input: Record<string, unknown>): Readonly<Record<string, unknown>>;
