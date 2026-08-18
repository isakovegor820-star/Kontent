import type { DraftCreateInput } from "./draft-types";
import { sanitizeSemanticIntent, topicFromSourceText } from "./reference-adaptation";

export interface TrendReferenceDraftInput {
  trendId: number | string;
  channelId: number;
  clientKey: string;
  sourceLabel: string;
  scope?: "niche" | "internet" | "global";
  text?: string | null;
  idea?: {
    topic?: string | null;
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
  const topic = sanitizeSemanticIntent(input.idea?.topic, 320) || topicFromSourceText(text);
  if (!topic) throw new RangeError("trend reference topic is required");

  return {
    text,
    media: null,
    scheduledAt: null,
    origin: "trend",
    sourceRef: {
      kind: "trend",
      id: trendId,
      label: input.sourceLabel.trim().slice(0, 400) || "Идея из трендов",
      topic,
      ...(input.idea?.hook?.trim() ? { hook: input.idea.hook.trim().slice(0, 1_000) } : {}),
      ...(input.idea?.structure?.trim() ? { structure: input.idea.structure.trim().slice(0, 2_000) } : {}),
      provenance: {
        kind: input.scope === "global"
          ? "trend"
          : input.scope === "internet"
            ? "radar_result"
            : "competitor_post",
        id: trendId,
        label: input.sourceLabel.trim().slice(0, 400) || "Идея из трендов",
      },
    },
    channelIds: [input.channelId],
    aiValidation: null,
    clientKey,
  };
}
