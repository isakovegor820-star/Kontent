export const SITE_PROBE_LIMITS: Readonly<{ maxQuestions: number; maxEngines: number }>;
export const SITE_PROBE_PROMPT_VERSION: string;
export type ProbeQuestion = Readonly<{ key: string; text: string; kind: string }>;
export function buildProbeQuestions(input: Record<string, unknown>): readonly ProbeQuestion[];
export function probeSystemPrompt(): string;
export function extractMentions(input: { answer: string; brandName?: string | null; domain?: string | null; competitorNames?: string[] }): Readonly<{ brandMentioned: boolean; siteCited: boolean; competitors: ReadonlyArray<{ name: string; kind: string }>; excerpt: string }>;
export function summarizeProbeRun(rows: Array<Record<string, unknown>>): Readonly<{
  questions: number;
  answers: number;
  skipped: number;
  failed: number;
  brandMentioned: number;
  siteCited: number;
  engines: string[];
  competitorsTop: ReadonlyArray<{ name: string; mentions: number }>;
}>;
