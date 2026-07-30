export type Address = "ты" | "вы" | "neutral";
export type FactsPolicy = "source_required" | "no_unverified_specifics" | "open";

export interface PostQuality {
  version: 1;
  preset: "expert" | "legal" | "custom";
  tone: string;
  energy: string;
  persona: string;
  address: Address;
  humor: "none" | "light" | "free";
  profanity: "forbid" | "allow";
  languageLevel: string;
  minChars: number;
  maxChars: number;
  hookRequired: boolean;
  hookMaxChars: number;
  maxParagraphSentences: number;
  requireConclusion: boolean;
  listPolicy: "when_useful" | "required" | "avoid";
  boldPolicy: "none" | "restrained" | "required";
  directSpeech: "avoid" | "allowed";
  factsPolicy: FactsPolicy;
  minCitationShare: number;
  disclaimerRequired: boolean;
  disclaimerText: string;
  ctaStyle: "none" | "soft" | "direct";
  ctaEveryPosts: number;
  salesMaxPercent: number;
  emojiPolicy: "none" | "restrained" | "active";
  maxEmojis: number;
  hashtagsPolicy: "none" | "restrained";
  maxHashtags: number;
  competitorTopics: boolean;
  forbiddenPhrases: string[];
  forbiddenTopics: string[];
  styleExamples: string[];
  qualityThreshold: number;
  retryLimit: number;
}

export interface QualityViolation {
  code: string;
  message: string;
  blocker: boolean;
  penalty: number;
}

export interface QualityResult {
  score: number;
  threshold: number;
  passed: boolean;
  blockers: string[];
  violations: QualityViolation[];
  metrics: {
    chars: number;
    emojiCount: number;
    hashtagCount: number;
    supportCount: number;
    citedShare: number | null;
  };
}

export const QUALITY_PRESETS: Record<
  string,
  { id: string; label: string; description: string; quality: PostQuality }
>;
export const DEFAULT_POST_QUALITY: Readonly<PostQuality>;
export function presetQuality(id: string): PostQuality;
export function normalizePostQuality(raw: unknown): PostQuality;
export function buildQualityPrompt(raw: unknown, options?: { postIndex?: number }): string;
export function validatePostQuality(
  text: string,
  raw: unknown,
  context?: {
    supportCount?: number;
    citedShare?: number | null;
    invented?: string[];
    topic?: string;
    postIndex?: number;
  },
): QualityResult;
export function buildRewritePrompt(draft: string, result?: QualityResult): string;
export function validateTopicQuality(
  topic: string,
  sourceText?: string,
): { passed: boolean; value: string; violations: string[] };
export function fallbackTopicFromSeed(seedText: string): string;
