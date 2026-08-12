import { createHash } from "node:crypto";

import { providerSupportsOperation } from "./provider-capabilities.mjs";
import {
  buildPublicationBlockSnapshot,
  REUSABLE_BLOCK_KINDS,
  type FirstCommentFallback,
  type ReusableBlock,
  type ReusableBlockKind,
} from "./publication-blocks";
import { renderPublicationTracking } from "./publication-tracking";
import type { DraftTrackingSelection } from "./draft-types";

export type ApprovedPublicationPreferences = {
  version: number;
  selectedBlocks: readonly ReusableBlock[];
  firstCommentFallback: FirstCommentFallback;
  commentsMode: "provider_default" | "enabled" | "disabled";
  pinAfterPublish: boolean;
  reviewAt: string | null;
  reviewResponsibleUserId: number | null;
};

type EffectiveBlockSnapshot = Omit<ReturnType<typeof buildPublicationBlockSnapshot>, "firstComment"> & {
  firstComment: {
    text: string;
    blockId: number | null;
    blockVersion: number | null;
    fallback: FirstCommentFallback;
    delivery: "provider_comment" | "appended" | "skipped";
    source?: "block" | "tracking" | "block_and_tracking";
  } | null;
};

export type DestinationPublicationRender = {
  mainText: string;
  firstCommentText: string | null;
  publicUrl: string | null;
  blockSnapshot: EffectiveBlockSnapshot;
  capabilities: {
    firstComment: boolean;
    commentToggle: boolean;
    pin: boolean;
  };
};

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseApprovedPublicationPreferences(
  value: unknown,
  projectId: number,
): ApprovedPublicationPreferences {
  const input = record(value);
  if (!input) throw new Error("publication_preferences_missing");
  const version = Number(input.version);
  if (!Number.isSafeInteger(version) || version < 0) throw new Error("publication_preferences_invalid");
  if (!Array.isArray(input.selectedBlocks) || input.selectedBlocks.length > 12) {
    throw new Error("publication_preferences_invalid");
  }
  const selectedBlocks = input.selectedBlocks.map((raw): ReusableBlock => {
    const block = record(raw);
    const id = positiveInteger(block?.id);
    const blockVersion = positiveInteger(block?.version);
    const kind = String(block?.kind || "") as ReusableBlockKind;
    const name = String(block?.name || "").trim();
    const text = String(block?.text || "").trim();
    if (
      id == null || blockVersion == null || !REUSABLE_BLOCK_KINDS.includes(kind)
      || !name || name.length > 120 || !text || text.length > 2_000
    ) throw new Error("publication_preferences_invalid");
    return { id, projectId, kind, name, text, version: blockVersion, enabled: true };
  });
  if (new Set(selectedBlocks.map((block) => block.id)).size !== selectedBlocks.length) {
    throw new Error("publication_preferences_invalid");
  }
  if (selectedBlocks.filter((block) => block.kind === "first_comment").length > 1) {
    throw new Error("publication_preferences_invalid");
  }
  const firstCommentFallback = String(input.firstCommentFallback || "skip") as FirstCommentFallback;
  if (!(firstCommentFallback === "append_to_post" || firstCommentFallback === "skip")) {
    throw new Error("publication_preferences_invalid");
  }
  const commentsMode = String(input.commentsMode || "provider_default");
  if (!(commentsMode === "provider_default" || commentsMode === "enabled" || commentsMode === "disabled")) {
    throw new Error("publication_preferences_invalid");
  }
  if (typeof input.pinAfterPublish !== "boolean") throw new Error("publication_preferences_invalid");
  const reviewAt = input.reviewAt == null ? null : new Date(String(input.reviewAt));
  const reviewResponsibleUserId = input.reviewResponsibleUserId == null
    ? null
    : positiveInteger(input.reviewResponsibleUserId);
  if (
    (reviewAt == null) !== (reviewResponsibleUserId == null)
    || (reviewAt != null && Number.isNaN(reviewAt.getTime()))
  ) throw new Error("publication_preferences_invalid");
  return {
    version,
    selectedBlocks,
    firstCommentFallback,
    commentsMode,
    pinAfterPublish: input.pinAfterPublish,
    reviewAt: reviewAt?.toISOString() ?? null,
    reviewResponsibleUserId,
  };
}

function snapshotHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function join(parts: readonly (string | null | undefined)[]) {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join("\n\n");
}

export function renderPublicationForDestination(input: {
  projectId: number;
  body: string;
  providerId: string;
  preferences: ApprovedPublicationPreferences;
  tracking: DraftTrackingSelection | null;
  appUrl: string;
}): DestinationPublicationRender {
  const capabilities = {
    firstComment: providerSupportsOperation(input.providerId, "firstComment"),
    commentToggle: providerSupportsOperation(input.providerId, "commentToggle"),
    pin: providerSupportsOperation(input.providerId, "pin"),
  };
  const baseBlocks = buildPublicationBlockSnapshot({
    projectId: input.projectId,
    body: input.body,
    selectedBlockIds: input.preferences.selectedBlocks.map((block) => block.id),
    blocks: input.preferences.selectedBlocks,
    providerSupportsFirstComment: capabilities.firstComment,
    firstCommentFallback: input.preferences.firstCommentFallback,
  });
  const trackingRender = renderPublicationTracking(baseBlocks.renderedText, input.tracking, input.appUrl);
  let mainText = trackingRender.mainText;
  const providerBlockComment = baseBlocks.firstComment?.delivery === "provider_comment"
    ? baseBlocks.firstComment.text
    : null;
  const firstCommentText = capabilities.firstComment
    ? join([providerBlockComment, trackingRender.firstCommentText]) || null
    : null;
  if (
    !capabilities.firstComment
    && trackingRender.firstCommentText
    && input.preferences.firstCommentFallback === "append_to_post"
  ) {
    mainText = join([mainText, trackingRender.firstCommentText]);
  }
  const firstComment = firstCommentText
    ? {
        text: firstCommentText,
        blockId: baseBlocks.firstComment?.blockId ?? null,
        blockVersion: baseBlocks.firstComment?.blockVersion ?? null,
        fallback: input.preferences.firstCommentFallback,
        delivery: "provider_comment" as const,
        source: providerBlockComment && trackingRender.firstCommentText
          ? "block_and_tracking" as const
          : providerBlockComment
            ? "block" as const
            : "tracking" as const,
      }
    : baseBlocks.firstComment;
  const blockSnapshot = {
    ...baseBlocks,
    renderedText: mainText,
    firstComment,
    contentHash: snapshotHash({
      version: 1,
      body: baseBlocks.body,
      renderedText: mainText,
      blocks: baseBlocks.blocks,
      firstComment,
    }),
  };
  return {
    mainText,
    firstCommentText,
    publicUrl: trackingRender.publicUrl,
    blockSnapshot,
    capabilities,
  };
}
