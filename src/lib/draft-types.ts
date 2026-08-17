import type { Network, Post } from "./types";
import type { FactualValidationProvenance } from "./fact-ledger";
import type { LocalScheduleInput } from "./timezone-schedule";
import type { UtmValues } from "./utm";

export interface DraftAiValidation {
  version: 1;
  status: "passed" | "blocked" | "not_checked";
  requiresReview: boolean;
  provenance: FactualValidationProvenance;
  blockerCodes: string[];
  topicAlignment?: {
    status: "passed" | "failed";
    score: number;
    topic: string;
  };
}

export interface DraftHumanReview {
  policy_version: 1;
  draft_version: number;
  attested_at: string;
}

export interface DraftDestination {
  channel_id: number;
  network: Network;
  title: string | null;
  handle: string | null;
  is_active: boolean;
}

/**
 * Editable tracking choice stored with one draft revision. When `shortLinkId` is
 * present, the destination and UTM values are always rebuilt from that
 * project-owned server record before persistence.
 */
export interface DraftTrackingSelection {
  shortLinkId: number | null;
  shortUrlPath: string | null;
  destination: string;
  utmValues: UtmValues;
  placement: "post" | "first_comment" | "cta" | "source";
}

/** JSON-контракт серверного черновика. Имена полей совпадают с остальными DB API. */
export interface ServerDraft {
  id: number;
  /** Server-owned project author identity used by the shared team calendar. */
  author_user_id?: number;
  author_name?: string;
  editorial_state?: "draft" | "in_review" | "changes_requested" | "approved";
  text: string;
  media: Post["media"];
  /** Optional only for compatibility with cached/pre-migration API payloads. */
  tracking?: DraftTrackingSelection | null;
  scheduled_at: string | null;
  /** Optional only for compatibility with cached/pre-migration API payloads. New writes always return it. */
  scheduled_timezone?: string | null;
  scheduled_local_date?: string | null;
  scheduled_local_time?: string | null;
  scheduled_offset?: string | null;
  scheduled_disambiguation?: "reject" | "earlier" | "later" | null;
  origin: Post["origin"];
  purpose: "source_context" | "publishable" | "needs_review";
  source_ref: Post["sourceRef"] | null;
  generation_result_id: number | null;
  generation_binding_valid: boolean;
  client_key: string;
  version: number;
  review_policy_version: 1;
  ai_validation: DraftAiValidation | null;
  human_review: DraftHumanReview | null;
  created_at: string;
  updated_at: string;
  destinations: DraftDestination[];
}

export interface DraftWriteInput {
  text: string;
  media: Post["media"];
  scheduledAt: string | null;
  schedule?: LocalScheduleInput | null;
  origin: Post["origin"];
  sourceRef: Post["sourceRef"] | null;
  channelIds: number[];
  aiValidation: DraftAiValidation | null;
  generationResultId?: number | null;
  /** Optional only for compatibility with older offline outbox records. */
  tracking?: DraftTrackingSelection | null;
}

export interface DraftCreateInput extends DraftWriteInput {
  clientKey: string;
}

export interface DraftUpdateInput extends DraftWriteInput {
  version: number;
}

export interface DraftScheduleUpdateInput {
  version: number;
  scheduledAt: string;
  schedule: LocalScheduleInput;
}

export type DraftSaveState = "idle" | "pending" | "saving" | "saved" | "failed" | "offline" | "conflict";
