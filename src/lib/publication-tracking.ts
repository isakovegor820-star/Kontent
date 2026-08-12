import type { DraftTrackingSelection } from "./draft-types";
import { buildTrackedDestination } from "./utm";

export type PublicationTrackingRender = {
  mainText: string;
  firstCommentText: string | null;
  publicUrl: string | null;
};

const SHORT_LINK_PATH = /^\/r\/[A-Za-z0-9_-]{20,64}$/u;

function normalizedPublicOrigin(value: string) {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error("invalid_public_origin");
  }
  return url.origin;
}

export function publicationTrackingUrl(
  tracking: DraftTrackingSelection,
  publicOrigin: string,
) {
  if (tracking.shortLinkId == null) {
    if (tracking.shortUrlPath != null) throw new Error("invalid_short_link_binding");
    return buildTrackedDestination(tracking.destination, tracking.utmValues);
  }
  if (!tracking.shortUrlPath || !SHORT_LINK_PATH.test(tracking.shortUrlPath)) {
    throw new Error("invalid_short_link_binding");
  }
  return new URL(tracking.shortUrlPath, `${normalizedPublicOrigin(publicOrigin)}/`).toString();
}

function appendBlock(text: string, block: string) {
  if (!text) return block;
  if (text.endsWith("\n\n")) return `${text}${block}`;
  if (text.endsWith("\n")) return `${text}\n${block}`;
  return `${text}\n\n${block}`;
}

/**
 * One deterministic rendering contract shared by preview and the publication API.
 * The editable draft stays unchanged; the immutable publication snapshot receives
 * the exact visible link block and, when selected, the exact first comment.
 */
export function renderPublicationTracking(
  text: string,
  tracking: DraftTrackingSelection | null,
  publicOrigin: string,
): PublicationTrackingRender {
  if (!tracking) return { mainText: text, firstCommentText: null, publicUrl: null };

  const publicUrl = publicationTrackingUrl(tracking, publicOrigin);
  if (tracking.placement === "first_comment") {
    return {
      mainText: text,
      firstCommentText: `Подробнее: ${publicUrl}`,
      publicUrl,
    };
  }

  const block = tracking.placement === "cta"
    ? `Подробнее: ${publicUrl}`
    : tracking.placement === "source"
      ? `Источник: ${publicUrl}`
      : publicUrl;
  return {
    mainText: appendBlock(text, block),
    firstCommentText: null,
    publicUrl,
  };
}
