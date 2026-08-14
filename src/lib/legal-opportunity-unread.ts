import {
  isLikelyLegalOpportunity,
  legalOpportunityFingerprint,
} from "./legal-opportunities";

export const LEGAL_OPPORTUNITY_UNREAD_EVENT = "aurora:legal-opportunities-unread";
export type LegalOpportunityVisualState = "new" | "viewed" | "used" | "hidden";

export type LegalOpportunityUnreadItem = Readonly<{
  id: number;
  title: string | null;
  summary: string | null;
  feed_title: string | null;
  read_at: string | Date | null;
  opportunity_state: "saved" | "dismissed" | "used" | null;
  post_id: number | null;
  status: "new" | "posted" | "skipped";
  skip_reason: "limit" | "irrelevant" | "baseline" | "paused" | null;
}>;

function isInteracted(item: LegalOpportunityUnreadItem): boolean {
  return item.read_at != null
    || item.opportunity_state != null
    || item.post_id != null
    || item.status === "posted";
}

export function legalOpportunityVisualState(
  item: LegalOpportunityUnreadItem,
): LegalOpportunityVisualState {
  if (item.post_id != null || item.status === "posted" || item.opportunity_state === "used") return "used";
  if (item.opportunity_state === "dismissed") return "hidden";
  if (item.read_at != null || item.opportunity_state === "saved") return "viewed";
  return "new";
}

/**
 * Считает именно видимые инфоповоды: нерелевантные записи и дубли одного акта
 * не раздувают badge. Любое прочтение или действие с дублем закрывает всю группу.
 */
export function unreadLegalOpportunityCount(items: readonly LegalOpportunityUnreadItem[]): number {
  const groups = new Map<string, { interacted: boolean }>();

  for (const item of items) {
    if (item.skip_reason === "irrelevant" || item.skip_reason === "paused") continue;
    if (!isLikelyLegalOpportunity({
      title: item.title,
      summary: item.summary,
      feedTitle: item.feed_title,
    })) continue;

    const fingerprint = legalOpportunityFingerprint(item);
    const group = groups.get(fingerprint) ?? { interacted: false };
    group.interacted ||= isInteracted(item);
    groups.set(fingerprint, group);
  }

  return Array.from(groups.values()).filter((group) => !group.interacted).length;
}

export function safeLegalOpportunityUnreadCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(count));
}

export function emitLegalOpportunityUnreadCount(value: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LEGAL_OPPORTUNITY_UNREAD_EVENT, {
    detail: { count: safeLegalOpportunityUnreadCount(value) },
  }));
}
