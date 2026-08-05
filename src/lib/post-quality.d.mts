export type Address = "ты" | "вы" | "neutral";
export type FactsPolicy = "source_required" | "no_unverified_specifics" | "open";

export interface PostQuality {
  version: 1;
  preset: "expert" | "legal" | "custom";
  tone: string;
  energy: string;
  energyLevel: number;
  warmth: number;
  inspiration: number;
  provocation: number;
  formality: number;
  expertise: number;
  authorVoice: number;
  persona: string;
  address: Address;
  humor: "none" | "light" | "free";
  humorLevel: number;
  opinionSharpness: number;
  profanity: "forbid" | "allow";
  profanityLevel: number;
  languageLevel: string;
  languageComplexity: number;
  originality: number;
  minChars: number;
  maxChars: number;
  hookRequired: boolean;
  hookMaxChars: number;
  maxParagraphSentences: number;
  sentenceRhythm: number;
  requireConclusion: boolean;
  listPolicy: "when_useful" | "required" | "avoid";
  listIntensity: number;
  boldPolicy: "none" | "restrained" | "required";
  boldIntensity: number;
  formatStyle: number;
  directSpeech: "avoid" | "allowed";
  hookStyle: number;
  hookIntensity: number;
  quoteIntensity: number;
  sceneIntensity: number;
  readerDialogue: number;
  factsPolicy: FactsPolicy;
  factShare: number;
  minCitationShare: number;
  personalStoryShare: number;
  trendFocus: number;
  audienceExpertise: number;
  postGoal: number;
  disclaimerRequired: boolean;
  disclaimerText: string;
  ctaStyle: "none" | "soft" | "direct";
  ctaIntensity: number;
  ctaEveryPosts: number;
  interactivity: number;
  salesMaxPercent: number;
  emojiPolicy: "none" | "restrained" | "active";
  maxEmojis: number;
  hashtagsPolicy: "none" | "restrained";
  maxHashtags: number;
  allowedEmoji: string;
  brandedHashtags: string;
  sourceLinkIntensity: number;
  mentionIntensity: number;
  visualIntensity: number;
  visualDetail: number;
  linkRules: string;
  visualDirection: string;
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

export type QualityCheckTrigger = "direct" | "generation" | "rewrite" | "edit_recheck";

export interface HumanQualityAttestation {
  kind: "human_review";
  userId: number;
  attestedAt: string;
}

export interface QualityMetadata {
  checkedAt: string;
  rules: {
    id: "aurora-post-quality";
    version: 1;
    profileVersion: 1;
  };
  provenance: {
    kind: "deterministic";
    validator: "validatePostQuality";
    trigger: QualityCheckTrigger;
    humanAttestation: HumanQualityAttestation | null;
  };
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
  metadata: QualityMetadata;
  semantic?: import("./semantic-claims.mjs").SemanticPublicationResult;
}

export const QUALITY_PRESETS: Record<
  string,
  { id: string; label: string; description: string; quality: PostQuality }
>;
export const DEFAULT_POST_QUALITY: Readonly<PostQuality>;
export const POST_QUALITY_RULES: Readonly<{ id: "aurora-post-quality"; version: 1 }>;
export function presetQuality(id: string): PostQuality;
export function normalizePostQuality(raw: unknown): PostQuality;
export function hasVerifiedQualityMetadata(result: unknown): boolean;
export function hasHumanQualityAttestation(result: unknown): boolean;
export function hasAutomaticQualityApproval(result: unknown): boolean;
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
    checkedAt?: string | number | Date;
    trigger?: QualityCheckTrigger;
  },
): QualityResult;
export function buildRewritePrompt(draft: string, result?: QualityResult): string;
export function validateTopicQuality(
  topic: string,
  sourceText?: string,
): { passed: boolean; value: string; violations: string[] };
export function fallbackTopicFromSeed(seedText: string): string;
export function fallbackTopicVariantFromSeed(seedText: string): string;
