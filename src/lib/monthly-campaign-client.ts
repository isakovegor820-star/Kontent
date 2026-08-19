export type MonthlyCampaignRole = "owner" | "author" | "approver" | "publisher";
export type MonthlyCampaignStatus = "draft" | "in_review" | "approved";

export type MonthlyCampaignClientSummary = {
  id: number;
  goal: string;
  startsOn: string;
  endsOn: string;
  timezone: string;
  rubrics: string[];
  practiceMix: { name: string; kind: "practice" | "service"; weight: number }[];
  audience: string;
  funnelStages: ("awareness" | "consideration" | "consultation")[];
  postsPerWeek: number;
  importantDates: { date: string; label: string }[];
  ctas: string[];
  metrics: string[];
  version: number;
  updatedAt: string;
};

export type MonthlyCampaignClientItem = {
  id: number;
  itemKey: string;
  scheduledFor: string;
  position: number;
  title: string;
  rubric: string;
  practice: string;
  funnelStage: "awareness" | "consideration" | "consultation";
  state: "topic" | "detailed";
  approvalStatus: MonthlyCampaignStatus;
  draftId: number | null;
  postId: number | null;
  weeklyAutopilotPlanId: number | null;
  regenerationStatus: "idle" | "pending" | "processing" | "failed";
};

export type MonthlyCampaignClientPlan = {
  id: number;
  revision: number;
  status: MonthlyCampaignStatus;
  version: number;
  stale: boolean;
  items: MonthlyCampaignClientItem[];
};

export type MonthlyCampaignClientDetail = {
  campaign: MonthlyCampaignClientSummary;
  plans: MonthlyCampaignClientPlan[];
  regenerations: {
    id: number;
    planId: number;
    scope: "item" | "week";
    weekStartsOn: string | null;
    status: "pending" | "processing" | "completed" | "stale" | "retryable_failed" | "failed" | "cancelled";
    targetItemIds: number[];
    errorCode: string | null;
  }[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nullablePositive(value: unknown): number | null | undefined {
  if (value == null) return null;
  const number = positive(value);
  return number ?? undefined;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())
    ? value.map((item) => String(item).trim())
    : null;
}

function dateOnly(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
}

export function parseMonthlyCampaignSummary(value: unknown): MonthlyCampaignClientSummary | null {
  const source = record(value);
  if (!source) return null;
  const id = positive(source.id);
  const version = positive(source.version);
  const startsOn = dateOnly(source.startsOn);
  const endsOn = dateOnly(source.endsOn);
  const rubrics = strings(source.rubrics);
  const funnelStages = strings(source.funnelStages);
  const ctas = strings(source.ctas);
  const metrics = strings(source.metrics);
  if (!id || !version || !startsOn || !endsOn || !rubrics || !funnelStages || !ctas || !metrics
      || typeof source.goal !== "string" || !source.goal.trim()
      || typeof source.timezone !== "string" || !source.timezone.trim()
      || typeof source.audience !== "string" || !source.audience.trim()
      || !Array.isArray(source.practiceMix) || !Array.isArray(source.importantDates)
      || !Number.isSafeInteger(Number(source.postsPerWeek))) return null;
  const practiceMix = source.practiceMix.map((value) => {
    const item = record(value);
    if (!item || typeof item.name !== "string" || !item.name.trim()
        || (item.kind !== "practice" && item.kind !== "service")
        || !Number.isSafeInteger(Number(item.weight))) return null;
    return { name: item.name.trim(), kind: item.kind, weight: Number(item.weight) };
  });
  const importantDates = source.importantDates.map((value) => {
    const item = record(value);
    const date = dateOnly(item?.date);
    return item && date && typeof item.label === "string" && item.label.trim()
      ? { date, label: item.label.trim() }
      : null;
  });
  if (practiceMix.some((item) => item === null) || importantDates.some((item) => item === null)
      || funnelStages.some((stage) => !["awareness", "consideration", "consultation"].includes(stage))) {
    return null;
  }
  return {
    id,
    goal: source.goal.trim(),
    startsOn,
    endsOn,
    timezone: source.timezone.trim(),
    rubrics,
    practiceMix: practiceMix as MonthlyCampaignClientSummary["practiceMix"],
    audience: source.audience.trim(),
    funnelStages: funnelStages as MonthlyCampaignClientSummary["funnelStages"],
    postsPerWeek: Number(source.postsPerWeek),
    importantDates: importantDates as MonthlyCampaignClientSummary["importantDates"],
    ctas,
    metrics,
    version,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : "",
  };
}

function parseItem(value: unknown): MonthlyCampaignClientItem | null {
  const source = record(value);
  if (!source) return null;
  const id = positive(source.id);
  const scheduledFor = dateOnly(source.scheduledFor);
  const draftId = nullablePositive(source.draftId);
  const postId = nullablePositive(source.postId);
  const weeklyAutopilotPlanId = nullablePositive(source.weeklyAutopilotPlanId);
  if (!id || !scheduledFor || draftId === undefined || postId === undefined
      || weeklyAutopilotPlanId === undefined
      || typeof source.itemKey !== "string" || !source.itemKey
      || typeof source.title !== "string" || !source.title.trim()
      || typeof source.rubric !== "string" || !source.rubric.trim()
      || typeof source.practice !== "string" || !source.practice.trim()
      || !["awareness", "consideration", "consultation"].includes(String(source.funnelStage))
      || !["topic", "detailed"].includes(String(source.state))
      || !["draft", "in_review", "approved"].includes(String(source.approvalStatus))
      || !["idle", "pending", "processing", "failed"].includes(String(source.regenerationStatus))
      || !Number.isInteger(Number(source.position)) || Number(source.position) < 0) return null;
  return {
    id,
    itemKey: source.itemKey,
    scheduledFor,
    position: Number(source.position),
    title: source.title.trim(),
    rubric: source.rubric.trim(),
    practice: source.practice.trim(),
    funnelStage: source.funnelStage as MonthlyCampaignClientItem["funnelStage"],
    state: source.state as MonthlyCampaignClientItem["state"],
    approvalStatus: source.approvalStatus as MonthlyCampaignStatus,
    draftId,
    postId,
    weeklyAutopilotPlanId,
    regenerationStatus: source.regenerationStatus as MonthlyCampaignClientItem["regenerationStatus"],
  };
}

function parsePlan(value: unknown): MonthlyCampaignClientPlan | null {
  const source = record(value);
  if (!source || !Array.isArray(source.items)) return null;
  const id = positive(source.id);
  const revision = positive(source.revision);
  const version = positive(source.version);
  const items = source.items.map(parseItem);
  if (!id || !revision || !version || items.some((item) => item === null)
      || !["draft", "in_review", "approved"].includes(String(source.status))) return null;
  return {
    id,
    revision,
    version,
    status: source.status as MonthlyCampaignStatus,
    stale: source.stale === true,
    items: (items as MonthlyCampaignClientItem[])
      .sort((left, right) =>
        left.scheduledFor.localeCompare(right.scheduledFor)
        || left.position - right.position
        || left.id - right.id
      ),
  };
}

export function parseMonthlyCampaignList(value: unknown): MonthlyCampaignClientSummary[] | null {
  const source = record(value);
  if (!source || source.ok !== true || !Array.isArray(source.campaigns)) return null;
  const campaigns = source.campaigns.map(parseMonthlyCampaignSummary);
  return campaigns.some((campaign) => campaign === null)
    ? null
    : campaigns as MonthlyCampaignClientSummary[];
}

export function parseMonthlyCampaignDetail(value: unknown): MonthlyCampaignClientDetail | null {
  const source = record(value);
  const campaign = parseMonthlyCampaignSummary(source?.campaign);
  if (!source || source.ok !== true || !campaign || !Array.isArray(source.plans)
      || !Array.isArray(source.regenerations)) return null;
  const plans = source.plans.map(parsePlan);
  if (plans.some((plan) => plan === null)) return null;
  const regenerations = source.regenerations.map((value) => {
    const operation = record(value);
    const id = positive(operation?.id);
    const planId = positive(operation?.planId);
    const targetItemIds = Array.isArray(operation?.targetItemIds)
      ? operation.targetItemIds.map(positive)
      : [];
    if (!operation || !id || !planId || targetItemIds.some((item) => item === null)
        || !["item", "week"].includes(String(operation.scope))
        || !["pending", "processing", "completed", "stale", "retryable_failed", "failed", "cancelled"]
          .includes(String(operation.status))) return null;
    return {
      id,
      planId,
      scope: operation.scope as "item" | "week",
      weekStartsOn: operation.weekStartsOn == null ? null : dateOnly(operation.weekStartsOn),
      status: operation.status as MonthlyCampaignClientDetail["regenerations"][number]["status"],
      targetItemIds: targetItemIds as number[],
      errorCode: typeof operation.errorCode === "string" ? operation.errorCode : null,
    };
  });
  if (regenerations.some((operation) => operation === null)) return null;
  return {
    campaign,
    plans: plans as MonthlyCampaignClientPlan[],
    regenerations: regenerations as MonthlyCampaignClientDetail["regenerations"],
  };
}

export function campaignMonthRange(month: string): { startsOn: string; endsOn: string } | null {
  if (!/^\d{4}-\d{2}$/u.test(month)) return null;
  const [year, value] = month.split("-").map(Number);
  if (!Number.isInteger(year) || value < 1 || value > 12) return null;
  const startsOn = `${month}-01`;
  const endsOn = new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10);
  return { startsOn, endsOn };
}

export function equalPracticeMix(names: readonly string[]) {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (!unique.length) return [];
  const base = Math.floor(100 / unique.length);
  return unique.map((name, index) => ({
    name,
    kind: "practice" as const,
    weight: base + (index < 100 - base * unique.length ? 1 : 0),
  }));
}

export function campaignMonthTitle(startsOn: string): string {
  const date = new Date(`${startsOn}T00:00:00.000Z`);
  const month = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    month: "long",
  }).format(date);
  const titled = month ? month.charAt(0).toLocaleUpperCase("ru-RU") + month.slice(1) : month;
  return `${titled} ${date.getUTCFullYear()}`;
}

export type MonthlyCampaignEditorialWeek = {
  index: number;
  startsOn: string;
  endsOn: string;
  items: MonthlyCampaignClientItem[];
};

/** Seven consecutive campaign days from the 1st. Matches server week regeneration. */
export function campaignEditorialWeeks(
  items: readonly MonthlyCampaignClientItem[],
): MonthlyCampaignEditorialWeek[] {
  const weeks: MonthlyCampaignEditorialWeek[] = [];
  for (let offset = 0; offset < items.length; offset += 7) {
    const slice = items.slice(offset, offset + 7);
    if (!slice[0]) continue;
    weeks.push({
      index: weeks.length + 1,
      startsOn: slice[0].scheduledFor,
      endsOn: slice[slice.length - 1]?.scheduledFor ?? slice[0].scheduledFor,
      items: slice,
    });
  }
  return weeks;
}

export function monthCalendarCells(startsOn: string, endsOn: string): (string | null)[] {
  const start = Date.parse(`${startsOn}T00:00:00.000Z`);
  const end = Date.parse(`${endsOn}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const pad = (new Date(start).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = Array.from({ length: pad }, () => null);
  for (let at = start; at <= end; at += 86_400_000) {
    cells.push(new Date(at).toISOString().slice(0, 10));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function monthlyCampaignWorkflowStep(
  plan: MonthlyCampaignClientPlan | null,
): 1 | 2 | 3 {
  if (!plan || plan.status === "draft") return 1;
  if (plan.status === "in_review") return 2;
  return 3;
}

export function monthlyCampaignStudioPrompt(input: {
  title: string;
  rubric: string;
  practice: string;
  audience: string;
  goal: string;
  cta?: string;
}): string {
  const title = input.title.trim();
  const rubric = input.rubric.trim();
  const practice = input.practice.trim();
  const audience = input.audience.trim();
  const goal = input.goal.trim();
  const cta = input.cta?.trim();
  const parts = [
    `Напиши пост для Telegram по теме месяца: «${title}».`,
    `Рубрика: ${rubric}. Направление: ${practice}.`,
    `Для кого: ${audience}.`,
    `Цель кампании: ${goal}.`,
  ];
  if (cta) parts.push(`Призыв к действию: ${cta}.`);
  parts.push("Пиши по фактам из базы знаний канала. Не выдумывай законы, дела, цифры и обещания.");
  return parts.join(" ");
}
