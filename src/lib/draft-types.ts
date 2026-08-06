import type { Network, Post } from "./types";
import type { FactualValidationProvenance } from "./fact-ledger";

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

/** JSON-контракт серверного черновика. Имена полей совпадают с остальными DB API. */
export interface ServerDraft {
  id: number;
  text: string;
  media: Post["media"];
  scheduled_at: string | null;
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
  origin: Post["origin"];
  sourceRef: Post["sourceRef"] | null;
  channelIds: number[];
  aiValidation: DraftAiValidation | null;
  generationResultId?: number | null;
}

export interface DraftCreateInput extends DraftWriteInput {
  clientKey: string;
}

export interface DraftUpdateInput extends DraftWriteInput {
  version: number;
}

export type DraftSaveState = "idle" | "pending" | "saving" | "saved" | "failed" | "offline" | "conflict";
