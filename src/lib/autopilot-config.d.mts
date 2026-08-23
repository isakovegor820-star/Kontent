export type AutopilotEngineId =
  | "navy-deepseek-pro"
  | "navy-deepseek-flash"
  | "navy-gpt-5-4"
  | "navy-qwen-3-6"
  | "navy-minimax-m3";

export interface AutopilotEngineOption {
  id: AutopilotEngineId;
  label: string;
  note: string;
}

export interface AutopilotPresentationVariant {
  key: string;
  name: string;
  structure: string;
  hook: string;
  emojiMode: "none" | "one";
  hashtagsMode: "none" | "one_or_two";
}

export const AUTOPILOT_ENGINE_OPTIONS: readonly AutopilotEngineOption[];
export const DEFAULT_AUTOPILOT_ENGINE: AutopilotEngineId;
export const AUTOPILOT_JOB_ATTEMPTS: number;
export const AUTOPILOT_JOB_BACKOFF_MS: number;
export const AUTOPILOT_PLANNING_MONTHS: readonly number[];
export const AUTOPILOT_WEEKS_PER_MONTH: number;
export const MIN_AUTOPILOT_PLANNING_WEEKS: number;
export const MAX_AUTOPILOT_PLANNING_WEEKS: number;
export const DEFAULT_AUTOPILOT_PLANNING_WEEKS: number;
export const MAX_AUTOPILOT_PLAN_POSTS: number;
export const AUTOPILOT_DAILY_POSTS_PER_WEEK: number;
export const AUTOPILOT_SIMILARITY_THRESHOLD: number;

export function isAutopilotEngine(value: unknown): value is AutopilotEngineId;
export function normalizeAutopilotEngine(value: unknown, fallback?: AutopilotEngineId): AutopilotEngineId;
export function normalizePlanningMonths(value: unknown, fallback?: number): number;
export function planningWeeks(months: unknown): number;
export function isAutopilotPlanningWeeks(value: unknown): boolean;
export function normalizePlanningWeeks(value: unknown, fallback?: number): number;
export function plannedPostCountForWeeks(postFrequency: unknown, weeks: unknown): number;
export function plannedDailyAutopilotPostCount(weeks: unknown): number;
export function planCountWasCappedForWeeks(postFrequency: unknown, weeks: unknown): boolean;
export function plannedPostCount(postFrequency: unknown, months: unknown): number;
export function planCountWasCapped(postFrequency: unknown, months: unknown): boolean;
export function autopilotTextSimilarity(left: unknown, right: unknown): number;
export function autopilotTopicSimilarity(left: unknown, right: unknown): number;
export function findAutopilotNearDuplicate(
  candidate: { topic?: unknown; draft?: unknown },
  existing: Array<{ topic?: unknown; draft?: unknown }>,
  threshold?: number,
): { index: number; score: number; topicScore: number; textScore: number } | null;
export function autopilotPresentationVariant(index: number, quality?: Record<string, unknown>): AutopilotPresentationVariant;
export function presentationVariantPrompt(variant: AutopilotPresentationVariant): string;
export function applyAutopilotPresentation(
  draft: unknown,
  variant: AutopilotPresentationVariant,
  quality?: Record<string, unknown>,
  brief?: Record<string, unknown>,
  index?: number,
): string;
