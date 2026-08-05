import type { DraftCreateInput } from "./draft-types";

export interface TrendReferenceDraftInput {
  trendId: number | string;
  channelId: number;
  clientKey: string;
  sourceLabel: string;
  text?: string | null;
  idea?: {
    hook?: string | null;
    structure?: string | null;
  } | null;
}

/**
 * Persists a trend as a provenance-aware reference before navigation. The reference is
 * never treated as verified facts: Studio receives it separately from the user's task and
 * uses only its mechanic, structure and reader intent.
 */
export function buildTrendReferenceDraft(input: TrendReferenceDraftInput): DraftCreateInput {
  // PostgreSQL bigint is intentionally decoded by `pg` as a decimal string. Do not cast it
  // through Number: IDs above MAX_SAFE_INTEGER would silently lose provenance.
  const trendId = String(input.trendId).trim();
  if (!/^[1-9][0-9]{0,19}$/u.test(trendId)) throw new RangeError("trendId must be a positive bigint");
  if (!Number.isSafeInteger(input.channelId) || input.channelId <= 0) {
    throw new RangeError("channelId must be a positive safe integer");
  }
  const clientKey = input.clientKey.trim();
  if (!clientKey) throw new RangeError("clientKey is required");

  const text = input.text?.trim()
    || [input.idea?.hook, input.idea?.structure].filter(Boolean).join("\n\n").trim();
  if (!text) throw new RangeError("trend reference text is required");

  return {
    text,
    media: null,
    scheduledAt: null,
    origin: "trend",
    sourceRef: {
      kind: "trend",
      id: trendId,
      label: input.sourceLabel.trim().slice(0, 400) || "Идея из трендов",
    },
    channelIds: [input.channelId],
    aiValidation: null,
    clientKey,
  };
}
