export const SITE_CLASSIFIER_PROMPT_VERSION: string;
export const SITE_INTERPRETATION_PROMPT_VERSION: string;
export function buildClassifierPrompt(input: { pages: unknown[]; topics: unknown[]; confirmedDomain: string }): Readonly<{ system: string; user: string; promptVersion: string; pageCount: number }>;
export function parseClassifierResponse(text: string, options?: { knownUrls?: string[]; knownTopicKeys?: string[] }): Readonly<{ pageTypes: Readonly<Record<string, string>>; topicClusters: ReadonlyArray<Readonly<{ label: string; keys: readonly string[] }>> }>;
export function buildInterpretationPrompt(input: { payload: Record<string, unknown>; brandName?: string | null; niche?: string | null }): Readonly<{ system: string; user: string; promptVersion: string }>;
export type SiteReportInterpretation = Readonly<{
  version: string;
  engine: string | null;
  generatedAt: string;
  summary: string;
  whatItMeans: readonly string[];
  startWith: ReadonlyArray<{ key: string; title: string; priority: string | null; why: string }>;
  watchOut: readonly string[];
  disclaimer: string;
}>;
export function validateInterpretation(raw: unknown, options: { payload: Record<string, unknown>; engine?: string | null; promptVersion?: string }): { ok: boolean; issues: Array<Record<string, unknown>>; interpretation: SiteReportInterpretation };
