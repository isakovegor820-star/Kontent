import {
  attestServerDraftReview,
  createServerDraft,
  draftMatchesWrite,
} from "./draft-client";
import { composerAiReviewState } from "./draft-review";
import type { DraftCreateInput, ServerDraft } from "./draft-types";

export type TrendDraftReviewErrorCode =
  | "review_required"
  | "destination_required"
  | "draft_conflict"
  | "review_blocked"
  | "review_not_confirmed";

export class TrendDraftReviewError extends Error {
  constructor(public readonly code: TrendDraftReviewErrorCode) {
    super(code);
    this.name = "TrendDraftReviewError";
  }
}

export interface ReviewedTrendDraftInput {
  text: string;
  trendId: number;
  sourceLabel: string;
  channelId: number | null;
  clientKey: string;
  humanAcknowledged: boolean;
}

interface ReviewedTrendDraftDependencies {
  create: (input: DraftCreateInput) => Promise<{ draft: ServerDraft; created: boolean }>;
  attest: (id: number, version: number) => Promise<ServerDraft>;
}

const DEFAULT_DEPENDENCIES: ReviewedTrendDraftDependencies = {
  create: createServerDraft,
  attest: attestServerDraftReview,
};

/**
 * Persists an AI-origin trend draft and binds the human acknowledgement to the exact
 * server version before Composer can expose a publishing action.
 */
export async function createReviewedTrendDraft(
  input: ReviewedTrendDraftInput,
  dependencies: ReviewedTrendDraftDependencies = DEFAULT_DEPENDENCIES,
): Promise<ServerDraft> {
  if (!input.humanAcknowledged) throw new TrendDraftReviewError("review_required");
  const channelId = Number(input.channelId);
  if (!Number.isSafeInteger(channelId) || channelId <= 0) {
    throw new TrendDraftReviewError("destination_required");
  }

  const write: DraftCreateInput = {
    text: input.text,
    media: null,
    scheduledAt: null,
    origin: "ai",
    sourceRef: {
      kind: "trend",
      id: String(input.trendId).slice(0, 200),
      label: input.sourceLabel.trim().slice(0, 400) || "Идея из трендов",
    },
    channelIds: [channelId],
    aiValidation: null,
    clientKey: input.clientKey,
  };
  const created = await dependencies.create(write);
  if (!draftMatchesWrite(created.draft, write)) {
    throw new TrendDraftReviewError("draft_conflict");
  }

  const initialReviewState = composerAiReviewState(created.draft);
  if (initialReviewState === "blocked") {
    throw new TrendDraftReviewError("review_blocked");
  }
  const reviewed = initialReviewState === "required"
    ? await dependencies.attest(created.draft.id, created.draft.version)
    : created.draft;
  if (composerAiReviewState(reviewed) !== "none") {
    throw new TrendDraftReviewError("review_not_confirmed");
  }
  return reviewed;
}
