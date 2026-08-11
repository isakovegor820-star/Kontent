import { createHash } from "node:crypto";

export const CAMPAIGN_FUNNEL_STAGES = ["awareness", "consideration", "consultation"] as const;
export type CampaignFunnelStage = (typeof CAMPAIGN_FUNNEL_STAGES)[number];
export type CampaignItemState = "topic" | "detailed" | "approved";

export type MonthlyCampaignBrief = {
  goal: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  rubrics: readonly string[];
  practices: readonly string[];
  audience: string;
  funnelStages: readonly CampaignFunnelStage[];
  postsPerWeek: number;
  importantDates: readonly { date: string; label: string }[];
  ctas: readonly string[];
  metrics: readonly string[];
  profileVersion: number;
  contentBriefVersion: number;
};

export type MonthlyCampaignItem = {
  id: string;
  scheduledFor: string;
  position: number;
  title: string;
  rubric: string;
  practice: string;
  funnelStage: CampaignFunnelStage;
  state: CampaignItemState;
  approvedRevision: number | null;
  sourceItemId: string | null;
  weeklyItemId: number | null;
  draftId: number | null;
  postId: number | null;
};

export type DuplicateCandidate = {
  id: string;
  title: string;
  source: "current_plan" | "library" | "past_plan";
};

function cleanText(value: string, max: number) {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").slice(0, max);
}

function parseDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

export function validateMonthlyCampaignBrief(input: MonthlyCampaignBrief) {
  const errors: string[] = [];
  const start = parseDateOnly(input.startsOn);
  const end = parseDateOnly(input.endsOn);
  if (!cleanText(input.goal, 500)) errors.push("goal_required");
  if (!start || !end || end < start) errors.push("invalid_period");
  if (start && end) {
    const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
    if (days < 28 || days > 31) errors.push("period_must_be_month");
  }
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: input.timezone }).format(new Date());
  } catch {
    errors.push("invalid_timezone");
  }
  if (input.rubrics.length < 3 || input.rubrics.length > 6) errors.push("rubrics_3_to_6");
  if (new Set(input.rubrics.map((value) => cleanText(value, 120).toLowerCase())).size !== input.rubrics.length) {
    errors.push("rubrics_must_be_unique");
  }
  if (!input.practices.length) errors.push("practices_required");
  if (!cleanText(input.audience, 500)) errors.push("audience_required");
  if (!input.funnelStages.length || input.funnelStages.some((stage) => !CAMPAIGN_FUNNEL_STAGES.includes(stage))) {
    errors.push("funnel_stage_required");
  }
  if (!Number.isInteger(input.postsPerWeek) || input.postsPerWeek < 1 || input.postsPerWeek > 14) {
    errors.push("invalid_frequency");
  }
  if (!Number.isSafeInteger(input.profileVersion) || input.profileVersion < 1) errors.push("invalid_profile_version");
  if (!Number.isSafeInteger(input.contentBriefVersion) || input.contentBriefVersion < 1) {
    errors.push("invalid_content_brief_version");
  }
  for (const date of input.importantDates) {
    if (!parseDateOnly(date.date) || !cleanText(date.label, 160)) errors.push("invalid_important_date");
  }
  return [...new Set(errors)];
}

function canonicalBrief(brief: MonthlyCampaignBrief) {
  return {
    ...brief,
    goal: cleanText(brief.goal, 500),
    audience: cleanText(brief.audience, 500),
    rubrics: brief.rubrics.map((value) => cleanText(value, 120)),
    practices: brief.practices.map((value) => cleanText(value, 160)),
    funnelStages: [...brief.funnelStages],
    importantDates: [...brief.importantDates]
      .map((item) => ({ date: item.date, label: cleanText(item.label, 160) }))
      .sort((left, right) => left.date.localeCompare(right.date) || left.label.localeCompare(right.label)),
    ctas: brief.ctas.map((value) => cleanText(value, 240)),
    metrics: brief.metrics.map((value) => cleanText(value, 120)),
  };
}

export function monthlyCampaignBriefHash(brief: MonthlyCampaignBrief) {
  const errors = validateMonthlyCampaignBrief(brief);
  if (errors.length) throw new Error(`invalid_campaign_brief:${errors.join(",")}`);
  return createHash("sha256").update(JSON.stringify(canonicalBrief(brief))).digest("hex");
}

export function isMonthlyCampaignStale(input: {
  snapshotBriefHash: string;
  snapshotProfileVersion: number;
  snapshotContentBriefVersion: number;
  currentBrief: MonthlyCampaignBrief;
}) {
  return input.snapshotBriefHash !== monthlyCampaignBriefHash(input.currentBrief)
    || input.snapshotProfileVersion !== input.currentBrief.profileVersion
    || input.snapshotContentBriefVersion !== input.currentBrief.contentBriefVersion;
}

function titleTokens(value: string) {
  return new Set(
    value.toLowerCase().normalize("NFC").replace(/[^\p{L}\d]+/gu, " ").trim().split(/\s+/u)
      .filter((token) => token.length > 2),
  );
}

export function titleSimilarity(left: string, right: string) {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return (2 * intersection) / (a.size + b.size);
}

export function findCampaignDuplicates(
  title: string,
  candidates: readonly DuplicateCandidate[],
  threshold = 0.72,
) {
  return candidates
    .map((candidate) => ({ ...candidate, similarity: titleSimilarity(title, candidate.title) }))
    .filter((candidate) => candidate.similarity >= threshold)
    .sort((left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id));
}

export function assertCampaignItems(items: readonly MonthlyCampaignItem[]) {
  if (items.length < 28 || items.length > 31) throw new Error("campaign_must_have_28_to_31_topics");
  const ids = new Set<string>();
  const dates = new Set<string>();
  for (const item of items) {
    if (!item.id || ids.has(item.id)) throw new Error("duplicate_campaign_item_id");
    if (!parseDateOnly(item.scheduledFor)) throw new Error("invalid_campaign_item_date");
    if (dates.has(item.scheduledFor)) throw new Error("duplicate_campaign_item_date");
    if (!cleanText(item.title, 240)) throw new Error("campaign_item_title_required");
    ids.add(item.id);
    dates.add(item.scheduledFor);
  }
}

/** First week receives full material; later dates remain lightweight topics. */
export function materializeFirstCampaignWeek(items: readonly MonthlyCampaignItem[]) {
  assertCampaignItems(items);
  const first = [...items].sort((left, right) =>
    left.scheduledFor.localeCompare(right.scheduledFor) || left.position - right.position
  )[0];
  const firstDate = parseDateOnly(first.scheduledFor)!;
  const weekEnd = new Date(firstDate.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
  return items.map((item) => item.scheduledFor <= weekEnd && item.state === "topic"
    ? { ...item, state: "detailed" as const }
    : { ...item });
}

/** Used by drag-and-drop and by its keyboard Move earlier/later alternative. */
export function moveCampaignItem(
  items: readonly MonthlyCampaignItem[],
  itemId: string,
  direction: "earlier" | "later",
) {
  const ordered = [...items].sort((left, right) => left.position - right.position);
  const current = ordered.findIndex((item) => item.id === itemId);
  const target = direction === "earlier" ? current - 1 : current + 1;
  if (current < 0 || target < 0 || target >= ordered.length) return ordered;
  const currentItem = ordered[current];
  const targetItem = ordered[target];
  ordered[current] = { ...targetItem, position: currentItem.position, scheduledFor: currentItem.scheduledFor };
  ordered[target] = { ...currentItem, position: targetItem.position, scheduledFor: targetItem.scheduledFor };
  return ordered.sort((left, right) => left.position - right.position);
}

export function replaceOneCampaignItem(
  items: readonly MonthlyCampaignItem[],
  itemId: string,
  replacement: Pick<MonthlyCampaignItem, "title" | "rubric" | "practice" | "funnelStage">,
) {
  let found = false;
  const next = items.map((item) => {
    if (item.id !== itemId) return item;
    found = true;
    if (item.state === "approved") throw new Error("approved_item_requires_new_plan_revision");
    return { ...item, ...replacement };
  });
  if (!found) throw new Error("campaign_item_not_found");
  return next;
}
