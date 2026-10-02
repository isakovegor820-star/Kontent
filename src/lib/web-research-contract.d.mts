export type WebFindingKind = "law" | "benchmark" | "market" | "statistics" | "event" | "statement";
export type LegalStatus =
  | "in_force" | "signed" | "adopted"
  | "bill_second_reading" | "bill_first_reading" | "bill_submitted" | "bill_drafted"
  | "public_discussion" | "not_normative" | "unknown";

export type WebFindingRejectionCode =
  | "empty_claim" | "claim_too_long" | "missing_url" | "bad_url" | "non_source_domain"
  | "missing_quote" | "quote_not_in_source" | "source_too_short"
  | "missing_published_at" | "bad_published_at" | "future_dated_source" | "stale_source"
  | "missing_legal_status" | "unknown_legal_status" | "number_not_in_source" | "weak_source";

export interface WebFinding {
  fingerprint: string;
  kind: WebFindingKind;
  claim: string;
  quote: string;
  title: string | null;
  language: "RU" | "EN";
  legalStatus: LegalStatus | null;
  legalStatusLabel: string | null;
  source: {
    url: string;
    domain: string;
    label: string;
    tier: "official" | "professional" | "research" | "media" | "open";
    tierLabel: string;
    trust: number;
    registered: boolean;
  };
  publishedAt: string | null;
  /** false — дату публикации установить не удалось; выводить её в текст нельзя. */
  dateKnown: boolean;
  retrievedAt: string;
  ageDays: number;
  numbers: string[];
  corroboratingDomains: string[];
  corroborationCount: number;
  trusted: boolean;
  /** Источник вне реестра и без независимого подтверждения: ссылаться можно, верить на слово — нет. */
  unverifiedSource: boolean;
}

export interface WebFindingEvaluation {
  ok: boolean;
  code?: WebFindingRejectionCode;
  reason?: string;
  detail?: Record<string, unknown> | null;
  finding?: WebFinding;
}

export interface EvaluateWebFindingInput {
  kind?: WebFindingKind | string;
  claim?: string;
  quote?: string;
  sourceUrl?: string;
  sourceText?: string;
  publishedAt?: string | null;
  legalStatus?: string | null;
  title?: string | null;
  language?: string | null;
  corroborating?: Array<{ url?: string }>;
  now?: number;
}

export const WEB_FINDING_KINDS: readonly WebFindingKind[];
export const WEB_FINDING_KIND_LABELS: Readonly<Record<WebFindingKind, string>>;
export const LEGAL_STATUSES: readonly LegalStatus[];
export const LEGAL_STATUS_LABELS: Readonly<Record<LegalStatus, string>>;
export const LEGAL_STATUSES_IN_FORCE: readonly LegalStatus[];
export const LEGAL_STATUSES_PENDING: readonly LegalStatus[];
export const WEB_FINDING_REJECTION_LABELS: Readonly<Record<string, string>>;
export const WEB_FINDING_MAX_AGE_DAYS: Readonly<Record<WebFindingKind, number>>;
export const WEB_FINDING_MIN_QUOTE_LENGTH: number;

export class WebFindingRejected extends Error {
  readonly code: WebFindingRejectionCode;
  readonly detail: Record<string, unknown> | null;
}

export function normalizeForMatch(value: unknown): string;
export function sourceTextFromHtml(html: unknown): string;
export function decodeHtmlEntities(value: unknown): string;
export function verifyQuoteInSource(quote: unknown, sourceText: unknown): { found: boolean; reason: string | null };
export function extractClaimNumbers(value: unknown): string[];
export function hasNumericClaim(value: unknown): boolean;
export function classifyLegalStatus(value: unknown): { status: LegalStatus; confidence: number; marker: string | null };
export function webFindingFingerprint(finding: Partial<WebFinding> | null | undefined): string;
export function evaluateWebFinding(input: EvaluateWebFindingInput, options?: {
  now?: number;
  maxAgeDays?: number;
  /** Разрешить факт без даты публикации (диалог в Студии). По умолчанию запрещено. */
  allowMissingPublishedAt?: boolean;
  /** Пропустить источник вне реестра без подтверждения, пометив его как непроверенный. */
  allowOpenSources?: boolean;
}): WebFindingEvaluation;
export function buildWebFinding(input: EvaluateWebFindingInput, options?: {
  now?: number; maxAgeDays?: number; allowMissingPublishedAt?: boolean; allowOpenSources?: boolean;
}): WebFinding;
export function webFindingCitation(finding: WebFinding): string;
