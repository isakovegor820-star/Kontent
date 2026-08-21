import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import { ProjectAccessError, requireSelectedProjectPermission } from "./project-permissions";
import { resolveChannel } from "./autopilot";
import {
  LIBRARY_FORMULA_DEFAULTS,
  LIBRARY_FORMULA_VERSION,
  scoreLibraryCohorts,
  type LibraryScoredItem,
  type LibraryScoringInput,
} from "./library-scoring.mjs";

export const GROWTH_TIME_ZONE = "Europe/Moscow";
export const GROWTH_MOVE_KINDS = ["topic", "rhythm", "offer", "audience"] as const;
export type GrowthMoveKind = (typeof GROWTH_MOVE_KINDS)[number];
export const GROWTH_MOVE_STATUSES = ["open", "done", "skipped"] as const;
export type GrowthMoveStatus = (typeof GROWTH_MOVE_STATUSES)[number];
export const GROWTH_CONFIDENCE = ["answered", "hypothesis", "insufficient_data"] as const;
export type GrowthConfidence = (typeof GROWTH_CONFIDENCE)[number];

export type GrowthDiagnosisItem = {
  id: string;
  text: string;
  confidence: GrowthConfidence;
  href?: string;
};

export type GrowthEvidence = {
  sourceType: string;
  sourceLabel: string | null;
  href: string | null;
  sampleSize: number | null;
  periodLabel: string | null;
  observedAt: string | null;
  freshnessLabel: string;
  methodology: string;
  metricLabel: string;
  opportunityStrength: number;
  urgency: number;
  effort: "Небольшое" | "Среднее" | "Заметное";
};

export type GrowthLifecycle =
  | "open"
  | "draft_created"
  | "plan_created"
  | "scheduled"
  | "published"
  | "collecting"
  | "measured"
  | "done"
  | "skipped";

export type GrowthOutcome = {
  artifactLabel: string;
  artifactHref: string | null;
  postId: number | null;
  publishedAt: string | null;
  views: number | null;
  reactions: number | null;
  conversions: number | null;
  trackingAvailable: boolean;
  sampleSize: number;
  baselineViews: number | null;
  normalizedLift: number | null;
  dataQuality: "low" | "medium" | "high";
  maturity: "not_published" | "collecting" | "mature";
  checkpointHours: 24 | 48 | 168;
  elapsedHours: number;
  collectedAt: string | null;
  conclusion: string;
  methodology: string;
};

export type GrowthReadinessItem = {
  id: "competitors" | "site" | "posts" | "tracking";
  title: string;
  body: string;
  href: string;
  cta: string;
};

export type GrowthMoveDraft = {
  kind: GrowthMoveKind;
  confidence: GrowthConfidence;
  title: string;
  reason: string;
  prompt: string;
  sourceKind: "competitor_post" | "site_analysis" | "audience_question" | "stats" | null;
  sourceId: string | null;
  sourceLabel: string | null;
  missingSlots: number | null;
  fingerprint: string;
  evidence: GrowthEvidence;
  rankPosition?: number;
};

export type GrowthMoveRecord = GrowthMoveDraft & {
  id: number;
  status: GrowthMoveStatus;
  actionHref: string;
  weekStart: string;
  lifecycle: GrowthLifecycle;
  artifactDraftId: number | null;
  artifactAutopilotPlanId: number | null;
  outcome: GrowthOutcome | null;
};

export type GrowthBoard = {
  hasChannel: boolean;
  channelId: number | null;
  weekStart: string;
  previousWeekStart: string;
  diagnosis: GrowthDiagnosisItem[];
  moves: GrowthMoveRecord[];
  previousMoves: GrowthMoveRecord[];
  gaps: string[];
  goal: string | null;
  periodLabel: string;
  completedMoves: number;
  totalMoves: number;
  dataFreshness: string;
  weeklyInsight: string;
  readiness: GrowthReadinessItem[];
  learning: { state: "ready" | "collecting"; text: string; basis: string };
};

type OwnPost = { id: number; text: string; publishedAt: string };
type CompetitorHit = {
  id: number;
  text: string;
  views: number | null;
  handle: string;
  title: string | null;
};
type SiteOffer = {
  jobId: number;
  domain: string;
  answer: string;
  landing?: string | null;
};
type AudienceAsk = { id: number; question: string; occurrences?: number; lastSeenAt?: string | null };

export type GrowthSignals = {
  ownPosts30d: OwnPost[];
  ownPosts7d: number;
  competitorCount: number;
  competitorHits: CompetitorHit[];
  competitorWeeklyMedian: number | null;
  siteOffer: SiteOffer | null;
  audienceQuestion: AudienceAsk | null;
  goal: string | null;
  ownPublishedCount: number;
  latestDataAt: string | null;
  trackingStatus: string | null;
};

const STOP_WORDS = new Set([
  "этот", "эта", "это", "того", "также", "после", "перед", "только", "можно",
  "нужно", "когда", "чтобы", "который", "которая", "которые", "сегодня",
  "просто", "очень", "более", "между", "через", "или", "если", "ваш", "ваша",
  "that", "this", "with", "from", "your", "have", "been", "will",
]);

export function moscowCalendarDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: GROWTH_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function growthWeekStart(now = new Date()): string {
  const ymd = moscowCalendarDate(now);
  const [year, month, day] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dow = utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return utc.toISOString().slice(0, 10);
}

export function previousGrowthWeekStart(weekStart: string): string {
  const [year, month, day] = weekStart.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day - 7));
  return utc.toISOString().slice(0, 10);
}

export function significantTokens(text: string): Set<string> {
  const matches = String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/gu, " ")
    .match(/[a-zа-яё0-9]{4,}/gu) ?? [];
  return new Set(matches.filter((token) => !STOP_WORDS.has(token)));
}

export function tokenOverlap(left: string, right: string): number {
  const a = significantTokens(left);
  const b = significantTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / Math.min(a.size, b.size);
}

export function coversTopic(ownPosts: OwnPost[], topicText: string): boolean {
  return ownPosts.some((post) => tokenOverlap(post.text, topicText) >= 0.28);
}

export function growthFingerprint(parts: {
  kind: GrowthMoveKind;
  sourceKind: GrowthMoveDraft["sourceKind"];
  sourceId: string | null;
}): string {
  return createHash("sha256")
    .update(`${parts.kind}:${parts.sourceKind ?? "none"}:${parts.sourceId ?? "none"}`)
    .digest("hex");
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function topicLabel(text: string): string {
  const firstLine = String(text || "").split(/\n/u)[0] || "";
  return clip(firstLine.replace(/^#+\s*/u, ""), 80) || "эту тему";
}

export function buildGrowthDiagnosis(signals: GrowthSignals): {
  diagnosis: GrowthDiagnosisItem[];
  gaps: string[];
} {
  const diagnosis: GrowthDiagnosisItem[] = [];
  const gaps: string[] = [];

  if (signals.competitorCount < 2) {
    gaps.push("Добавь хотя бы двух конкурентов — иначе сравнивать ритм и темы не с чем.");
  }
  if (!signals.siteOffer) {
    gaps.push("Нет разбора сайта — ход про услугу не ставлю.");
  }

  if (signals.competitorWeeklyMedian != null && signals.competitorCount >= 2) {
    const target = Math.max(3, Math.round(signals.competitorWeeklyMedian));
    if (signals.ownPosts7d < target) {
      diagnosis.push({
        id: "rhythm",
        text: `Ты пишешь реже конкурентов: ${signals.ownPosts7d} ${pluralPosts(signals.ownPosts7d)} за неделю против их ${target}.`,
        confidence: signals.ownPosts30d.length > 0 ? "answered" : "hypothesis",
        href: "/app/analytics",
      });
    }
  }

  const uncovered = signals.competitorHits.find((hit) => !coversTopic(signals.ownPosts30d, hit.text));
  if (uncovered) {
    const who = uncovered.title || `@${uncovered.handle}`;
    diagnosis.push({
      id: "topic",
      text: `У ${who} заходит «${topicLabel(uncovered.text)}», у тебя таких постов за 30 дней нет.`,
      confidence: signals.competitorCount >= 2 && signals.competitorHits.length >= 3
        ? "answered" : "hypothesis",
      href: "/app/competitors",
    });
  } else if (signals.competitorHits.length === 0 && signals.competitorCount >= 2) {
    diagnosis.push({
      id: "topic-empty",
      text: "Конкуренты добавлены, но залётов ещё нет — подожди ближайший сбор.",
      confidence: "insufficient_data",
      href: "/app/competitors",
    });
  }

  if (signals.siteOffer) {
    const mentioned = coversTopic(signals.ownPosts30d, signals.siteOffer.answer)
      || (signals.siteOffer.landing
        ? signals.ownPosts30d.some((post) => post.text.includes(signals.siteOffer!.domain))
        : false);
    if (!mentioned) {
      diagnosis.push({
        id: "offer",
        text: `На сайте есть услуга, а в канале про неё молчишь: ${clip(signals.siteOffer.answer, 120)}`,
        confidence: "answered",
        href: "/app/site-analysis",
      });
    }
  }

  if (signals.audienceQuestion) {
    diagnosis.push({
      id: "audience",
      text: `Люди спрашивают то, на что ещё нет поста: «${clip(signals.audienceQuestion.question, 120)}»`,
      confidence: "answered",
      href: "/app/studio/questions",
    });
  }

  return { diagnosis, gaps };
}

const KIND_TIE_BREAK: Record<GrowthMoveKind, number> = {
  topic: 0,
  offer: 1,
  audience: 2,
  rhythm: 3,
};

export function goalFitForMove(goal: string | null, kind: GrowthMoveKind): number {
  const value = String(goal ?? "").toLocaleLowerCase("ru");
  if (!value) return 0;
  if (/продаж|заяв|выруч|клиент|лид/u.test(value)) {
    return ({ offer: 5, audience: 4, topic: 2, rhythm: 2 } as const)[kind];
  }
  if (/вовлеч|комьюнити|сообществ|диалог|общени/u.test(value)) {
    return ({ audience: 5, topic: 4, rhythm: 3, offer: 2 } as const)[kind];
  }
  if (/охват|бренд|узнаваем|подпис|аудитор/u.test(value)) {
    return ({ topic: 5, rhythm: 4, audience: 3, offer: 2 } as const)[kind];
  }
  if (/трафик|переход|сайт/u.test(value)) {
    return ({ offer: 4, topic: 4, audience: 3, rhythm: 2 } as const)[kind];
  }
  return 1;
}

export function evidenceWeight(confidence: GrowthConfidence): number {
  if (confidence === "answered") return 4;
  if (confidence === "hypothesis") return 2;
  return 0;
}

export function effortWeight(effort: GrowthEvidence["effort"]): number {
  if (effort === "Небольшое") return 2;
  if (effort === "Среднее") return 1;
  return 0;
}

/**
 * Internal ordering only. It is deliberately additive and inspectable: goal fit (0–5),
 * evidence (0–4), opportunity (0–4), urgency (0–3), lower effort (0–2), and a
 * concrete prompt/source (0–2). Stable kind/fingerprint tie-breaks prevent refresh jitter.
 */
export function rankGrowthMoves(
  drafts: GrowthMoveDraft[],
  goal: string | null,
): GrowthMoveDraft[] {
  return drafts
    .map((draft) => ({
      draft,
      score:
        goalFitForMove(goal, draft.kind)
        + evidenceWeight(draft.confidence)
        + Math.max(0, Math.min(4, draft.evidence.opportunityStrength))
        + Math.max(0, Math.min(3, draft.evidence.urgency))
        + effortWeight(draft.evidence.effort)
        + (draft.prompt.trim() && draft.sourceKind ? 2 : 0),
    }))
    .sort((left, right) =>
      right.score - left.score
      || KIND_TIE_BREAK[left.draft.kind] - KIND_TIE_BREAK[right.draft.kind]
      || left.draft.fingerprint.localeCompare(right.draft.fingerprint))
    .slice(0, 3)
    .map(({ draft }, index) => ({ ...draft, rankPosition: index + 1 }));
}

function evidence(input: Omit<GrowthEvidence, "freshnessLabel">): GrowthEvidence {
  return {
    ...input,
    freshnessLabel: input.observedAt ? humanFreshness(input.observedAt) : "Дата источника недоступна",
  };
}

export function buildGrowthMoves(signals: GrowthSignals): GrowthMoveDraft[] {
  const drafts: GrowthMoveDraft[] = [];

  const uncovered = signals.competitorHits.find((hit) => !coversTopic(signals.ownPosts30d, hit.text));
  if (uncovered) {
    const who = uncovered.title || `@${uncovered.handle}`;
    const topic = topicLabel(uncovered.text);
    drafts.push({
      kind: "topic",
      confidence: signals.competitorCount >= 2 && signals.competitorHits.length >= 3
        ? "answered" : "hypothesis",
      title: `Напиши свой пост про «${topic}»`,
      reason: `Тема заходит у ${who}. Пишем новый текст в голосе канала, не копию.`,
      prompt: [
        `Напиши новый пост в голосе канала на тему: «${topic}».`,
        `Тема заходит у конкурента ${who}. Не копируй чужой текст — напиши свой.`,
      ].join(" "),
      sourceKind: "competitor_post",
      sourceId: String(uncovered.id),
      sourceLabel: who,
      missingSlots: null,
      fingerprint: growthFingerprint({
        kind: "topic",
        sourceKind: "competitor_post",
        sourceId: String(uncovered.id),
      }),
      evidence: evidence({
        sourceType: "Пост конкурента",
        sourceLabel: who,
        href: "/app/competitors",
        sampleSize: signals.competitorHits.length || null,
        periodLabel: "последние 30 дней",
        observedAt: signals.latestDataAt,
        methodology: "Сравниваем подтверждённые залёты добавленных конкурентов с темами твоих публикаций за 30 дней.",
        metricLabel: uncovered.views == null
          ? "Пост отмечен как залёт; просмотры недоступны"
          : `${uncovered.views} просмотров у исходного поста`,
        opportunityStrength: uncovered.views != null && uncovered.views >= 1_000 ? 4 : 3,
        urgency: 2,
        effort: "Среднее",
      }),
    });
  }

  if (signals.competitorWeeklyMedian != null && signals.competitorCount >= 2) {
    const target = Math.max(3, Math.round(signals.competitorWeeklyMedian));
    const missing = target - signals.ownPosts7d;
    if (missing > 0) {
      drafts.push({
        kind: "rhythm",
        confidence: signals.ownPosts30d.length > 0 ? "answered" : "hypothesis",
        title: `Верни ритм: не хватает ${missing} ${pluralPosts(missing)}`,
        reason: `За неделю вышло ${signals.ownPosts7d}, у конкурентов обычно около ${target}.`,
        prompt: `Собери недельный план так, чтобы закрыть дыру в ${missing} ${pluralPosts(missing)}.`,
        sourceKind: "stats",
        sourceId: "7d",
        sourceLabel: "своя статистика",
        missingSlots: Math.min(20, missing),
        fingerprint: growthFingerprint({ kind: "rhythm", sourceKind: "stats", sourceId: "7d" }),
        evidence: evidence({
          sourceType: "Статистика публикаций",
          sourceLabel: "своя статистика и ритм конкурентов",
          href: "/app/analytics",
          sampleSize: signals.competitorCount,
          periodLabel: "7 дней против медианы за 28 дней",
          observedAt: signals.latestDataAt,
          methodology: "Сравниваем число твоих публикаций за 7 дней с медианным недельным темпом активных конкурентов за 28 дней.",
          metricLabel: `${signals.ownPosts7d} против медианы ${target}; не хватает ${missing}`,
          opportunityStrength: missing >= 3 ? 4 : missing >= 2 ? 3 : 2,
          urgency: missing >= 2 ? 3 : 2,
          effort: missing >= 4 ? "Заметное" : "Среднее",
        }),
      });
    }
  }

  if (signals.siteOffer) {
    const mentioned = coversTopic(signals.ownPosts30d, signals.siteOffer.answer)
      || signals.ownPosts30d.some((post) => post.text.includes(signals.siteOffer!.domain));
    if (!mentioned) {
      const landing = signals.siteOffer.landing ? ` Посадочная: ${signals.siteOffer.landing}.` : "";
      drafts.push({
        kind: "offer",
        confidence: "answered",
        title: "Сделай пост с понятным предложением",
        reason: clip(`На сайте есть услуга, в канале её не было: ${signals.siteOffer.answer}`, 500),
        prompt: clip(
          `Напиши пост с понятным предложением из разбора сайта: ${signals.siteOffer.answer}.${landing} Не обещай рост или результат, которого нет в фактах.`,
          2000,
        ),
        sourceKind: "site_analysis",
        sourceId: String(signals.siteOffer.jobId),
        sourceLabel: signals.siteOffer.domain,
        missingSlots: null,
        fingerprint: growthFingerprint({
          kind: "offer",
          sourceKind: "site_analysis",
          sourceId: String(signals.siteOffer.jobId),
        }),
        evidence: evidence({
          sourceType: "Разбор сайта",
          sourceLabel: signals.siteOffer.domain,
          href: "/app/site-analysis",
          sampleSize: 1,
          periodLabel: "последний завершённый разбор",
          observedAt: signals.latestDataAt,
          methodology: "Сопоставляем подтверждённое предложение из последнего разбора сайта с темами публикаций канала за 30 дней.",
          metricLabel: "Предложение найдено на сайте, но не найдено в недавних постах",
          opportunityStrength: 4,
          urgency: 2,
          effort: "Среднее",
        }),
      });
    }
  }

  if (signals.audienceQuestion) {
    drafts.push({
      kind: "audience",
      confidence: "answered",
      title: "Ответь на вопрос аудитории",
      reason: `Вопрос ещё без поста: «${clip(signals.audienceQuestion.question, 180)}»`,
      prompt: `Напиши пост-ответ на вопрос аудитории: «${clip(signals.audienceQuestion.question, 400)}»`,
      sourceKind: "audience_question",
      sourceId: String(signals.audienceQuestion.id),
      sourceLabel: "запрос аудитории",
      missingSlots: null,
      fingerprint: growthFingerprint({
        kind: "audience",
        sourceKind: "audience_question",
        sourceId: String(signals.audienceQuestion.id),
      }),
      evidence: evidence({
        sourceType: "Запрос аудитории",
        sourceLabel: "запрос аудитории",
        href: "/app/studio/questions",
        sampleSize: signals.audienceQuestion.occurrences ?? 1,
        periodLabel: "актуальный открытый запрос",
        observedAt: signals.audienceQuestion.lastSeenAt ?? signals.latestDataAt,
        methodology: "Берём открытый вопрос с наивысшим приоритетом и частотой, на который ещё нет связанного ответа.",
        metricLabel: signals.audienceQuestion.occurrences && signals.audienceQuestion.occurrences > 1
          ? `${signals.audienceQuestion.occurrences} похожих обращения`
          : "1 подтверждённый вопрос",
        opportunityStrength: (signals.audienceQuestion.occurrences ?? 1) >= 3 ? 4 : 3,
        urgency: 3,
        effort: "Небольшое",
      }),
    });
  }

  return rankGrowthMoves(drafts, signals.goal);
}

export function growthActionHref(input: {
  id: number;
  kind: GrowthMoveKind;
  channelId: number;
  sourceId: string | null;
}): string {
  const params = new URLSearchParams({
    growthMove: String(input.id),
    channel: String(input.channelId),
  });
  if (input.kind === "rhythm") return `/app/autopilot?${params.toString()}`;
  params.set("intent", "create");
  return `/app/studio?${params.toString()}`;
}

function pluralPosts(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs >= 11 && abs <= 14) return "постов";
  if (last === 1) return "пост";
  if (last >= 2 && last <= 4) return "поста";
  return "постов";
}

function humanFreshness(value: string | Date, now = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "Свежесть неизвестна";
  const hours = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 3_600_000));
  if (hours < 1) return "Обновлено меньше часа назад";
  if (hours < 24) return `Обновлено ${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `Обновлено ${days} ${days === 1 ? "день" : days < 5 ? "дня" : "дней"} назад`;
}

export function growthPeriodLabel(weekStart: string): string {
  const [year, month, day] = weekStart.split("-").map(Number);
  const from = new Date(Date.UTC(year, month - 1, day));
  const to = new Date(Date.UTC(year, month - 1, day + 6));
  const monthNames = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ] as const;
  const monthName = (date: Date) => monthNames[date.getUTCMonth()];
  if (from.getUTCMonth() === to.getUTCMonth()) {
    return `${from.getUTCDate()}–${to.getUTCDate()} ${monthName(to)}`;
  }
  return `${from.getUTCDate()} ${monthName(from)} – ${to.getUTCDate()} ${monthName(to)}`;
}

function fallbackEvidence(row: {
  source_kind: string | null;
  source_label: string | null;
  confidence: string;
}): GrowthEvidence {
  const sourceType = row.source_kind === "competitor_post" ? "Пост конкурента"
    : row.source_kind === "site_analysis" ? "Разбор сайта"
      : row.source_kind === "audience_question" ? "Запрос аудитории"
        : row.source_kind === "stats" ? "Статистика публикаций"
          : "Источник не сохранён";
  const href = row.source_kind === "competitor_post" ? "/app/competitors"
    : row.source_kind === "site_analysis" ? "/app/site-analysis"
      : row.source_kind === "audience_question" ? "/app/studio/questions"
        : row.source_kind === "stats" ? "/app/analytics" : null;
  return {
    sourceType,
    sourceLabel: row.source_label,
    href,
    sampleSize: null,
    periodLabel: null,
    observedAt: null,
    freshnessLabel: "Для старого хода свежесть не сохранена",
    methodology: row.confidence === "insufficient_data"
      ? "Данных недостаточно — вывод нужно проверить новыми публикациями."
      : "Ход создан по доступному на тот момент источнику; подробная методика появилась в новой версии.",
    metricLabel: "Подробная метрика для старого хода не сохранена",
    opportunityStrength: 0,
    urgency: 0,
    effort: "Среднее",
  };
}

function parseEvidence(value: unknown, row: Parameters<typeof fallbackEvidence>[0]): GrowthEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallbackEvidence(row);
  const source = value as Partial<GrowthEvidence>;
  const fallback = fallbackEvidence(row);
  return {
    sourceType: typeof source.sourceType === "string" ? source.sourceType : fallback.sourceType,
    sourceLabel: typeof source.sourceLabel === "string" ? source.sourceLabel : fallback.sourceLabel,
    href: typeof source.href === "string" ? source.href : fallback.href,
    sampleSize: Number.isSafeInteger(source.sampleSize) && Number(source.sampleSize) >= 0
      ? Number(source.sampleSize) : null,
    periodLabel: typeof source.periodLabel === "string" ? source.periodLabel : null,
    observedAt: typeof source.observedAt === "string" ? source.observedAt : null,
    freshnessLabel: typeof source.freshnessLabel === "string" ? source.freshnessLabel : fallback.freshnessLabel,
    methodology: typeof source.methodology === "string" ? source.methodology : fallback.methodology,
    metricLabel: typeof source.metricLabel === "string" ? source.metricLabel : fallback.metricLabel,
    opportunityStrength: Number(source.opportunityStrength) || 0,
    urgency: Number(source.urgency) || 0,
    effort: source.effort === "Небольшое" || source.effort === "Заметное" ? source.effort : "Среднее",
  };
}

function mapMove(row: {
  id: number | string;
  week_start: string;
  kind: string;
  status: string;
  confidence: string;
  title: string;
  reason: string;
  prompt: string;
  action_href: string;
  source_kind: string | null;
  source_id: string | null;
  source_label: string | null;
  fingerprint: string;
  missing_slots: number | null;
  rank_position?: number | null;
  evidence?: unknown;
  artifact_draft_id?: number | string | null;
  artifact_autopilot_plan_id?: number | string | null;
}): GrowthMoveRecord {
  const artifactDraftId = row.artifact_draft_id == null ? null : Number(row.artifact_draft_id);
  const artifactAutopilotPlanId = row.artifact_autopilot_plan_id == null
    ? null : Number(row.artifact_autopilot_plan_id);
  const status = row.status as GrowthMoveStatus;
  return {
    id: Number(row.id),
    weekStart: String(row.week_start).slice(0, 10),
    kind: row.kind as GrowthMoveKind,
    status,
    confidence: row.confidence as GrowthConfidence,
    title: row.title,
    reason: row.reason,
    prompt: row.prompt,
    actionHref: row.action_href,
    sourceKind: (row.source_kind as GrowthMoveRecord["sourceKind"]) ?? null,
    sourceId: row.source_id,
    sourceLabel: row.source_label,
    missingSlots: row.missing_slots == null ? null : Number(row.missing_slots),
    fingerprint: row.fingerprint,
    rankPosition: row.rank_position == null ? undefined : Number(row.rank_position),
    evidence: parseEvidence(row.evidence, row),
    lifecycle: status === "skipped" ? "skipped"
      : status === "done" ? "done"
        : artifactDraftId ? "draft_created"
          : artifactAutopilotPlanId ? "plan_created" : "open",
    artifactDraftId,
    artifactAutopilotPlanId,
    outcome: null,
  };
}

async function loadSignals(
  pool: Pick<Pool, "query">,
  input: { projectId: number; channelId: number },
): Promise<GrowthSignals> {
  const own = (
    await pool.query<{ id: string; text: string; published_at: string }>(
      `select id, text, published_at::text
         from posts
        where channel_id = $1
          and project_id = $2
          and status in ('published', 'published_unverified')
          and published_at >= now() - interval '30 days'
        order by published_at desc`,
      [input.channelId, input.projectId],
    )
  ).rows.map((row) => ({
    id: Number(row.id),
    text: row.text || "",
    publishedAt: row.published_at,
  }));

  const ownPosts7d = (
    await pool.query<{ n: string }>(
      `select count(*)::int as n
         from posts
        where channel_id = $1
          and project_id = $2
          and status in ('published', 'published_unverified')
          and published_at >= (
            date_trunc('day', now() at time zone 'Europe/Moscow') - interval '6 days'
          ) at time zone 'Europe/Moscow'`,
      [input.channelId, input.projectId],
    )
  ).rows[0];

  const competitorCount = Number((
    await pool.query<{ n: string }>(
      `select count(*)::int as n
         from competitors
        where channel_id = $1 and is_active = true`,
      [input.channelId],
    )
  ).rows[0]?.n ?? 0);

  const competitorHits = (
    await pool.query<{
      id: string;
      text: string | null;
      views: number | null;
      handle: string;
      title: string | null;
    }>(
      `select p.id, p.text, p.views, c.handle, coalesce(c.custom_title, c.title) as title
         from competitor_posts p
         join competitors c on c.id = p.competitor_id
        where c.channel_id = $1
          and c.is_active = true
          and p.posted_at >= now() - interval '30 days'
          and (
            p.is_hit = true
            or (p.views is not null and p.views >= 50)
          )
        order by p.is_hit desc, p.views desc nulls last, p.posted_at desc
        limit 12`,
      [input.channelId],
    )
  ).rows.map((row) => ({
    id: Number(row.id),
    text: row.text || "",
    views: row.views,
    handle: row.handle,
    title: row.title,
  }));

  const weekly = (
    await pool.query<{ weekly: string }>(
      `select percentile_cont(0.5) within group (order by weekly)::float as weekly
         from (
           select count(*)::float / 4.0 as weekly
             from competitor_posts p
             join competitors c on c.id = p.competitor_id
            where c.channel_id = $1
              and c.is_active = true
              and p.posted_at >= now() - interval '28 days'
            group by c.id
           having count(*) >= 4
         ) rates`,
      [input.channelId],
    )
  ).rows[0];

  const offerRow = (
    await pool.query<{
      job_id: string;
      domain: string;
      answer: string;
    }>(
      `select j.id as job_id, j.confirmed_domain as domain, a.short_answer as answer
         from site_analysis_jobs j
         join site_analysis_answers a
           on a.analysis_id = j.id and a.run_revision = j.run_revision
        where j.status = 'ready'
          and j.project_id = $1
          and a.question_id = 'offer.catalog'
          and a.status in ('answered', 'hypothesis')
        order by j.completed_at desc nulls last, j.id desc
        limit 1`,
      [input.projectId],
    )
  ).rows[0];

  const landingRow = offerRow
    ? (
      await pool.query<{ answer: string }>(
        `select a.short_answer as answer
           from site_analysis_answers a
          where a.analysis_id = $1
            and a.question_id = 'funnel.landing_pages'
            and a.status in ('answered', 'hypothesis')
          limit 1`,
        [Number(offerRow.job_id)],
      )
    ).rows[0]
    : null;

  const audienceRow = (
    await pool.query<{ id: string; question: string; occurrences: number; last_seen_at: string | null }>(
      `select id, question, occurrences, last_seen_at::text
         from audience_questions
        where project_id = $1 and status = 'new'
          and 1 = (
            select count(*)::int from channels
             where project_id = $1 and network = 'tg' and is_active = true and status = 'active'
          )
        order by priority desc, occurrences desc, last_seen_at desc, id desc
        limit 1`,
      [input.projectId],
    )
  ).rows[0];

  const briefRow = (
    await pool.query<{ goal: string | null }>(
      `select nullif(btrim(goal), '') as goal
         from content_brief
        where project_id = $1 and channel_id = $2
        order by ready desc, updated_at desc
        limit 1`,
      [input.projectId, input.channelId],
    )
  ).rows[0];

  const ownPublishedCount = Number((
    await pool.query<{ n: string }>(
      `select count(*)::int as n
         from posts
        where project_id = $1 and channel_id = $2
          and status in ('published', 'published_unverified')`,
      [input.projectId, input.channelId],
    )
  ).rows[0]?.n ?? 0);

  const latestDataAt = (
    await pool.query<{ collected_at: string | null }>(
      `select greatest(
          (select max(stats.collected_at) from post_stats stats
            join posts post on post.id = stats.post_id and post.project_id = stats.project_id
           where stats.project_id = $1 and post.channel_id = $2),
          (select max(posted_at) from competitor_posts post
            join competitors competitor on competitor.id = post.competitor_id
           where competitor.channel_id = $2 and competitor.is_active = true)
        )::text as collected_at`,
      [input.projectId, input.channelId],
    )
  ).rows[0]?.collected_at ?? null;

  const trackingStatus = (
    await pool.query<{ status: string }>(
      `select status from project_tracking_settings where project_id = $1`,
      [input.projectId],
    )
  ).rows[0]?.status ?? null;

  return {
    ownPosts30d: own,
    ownPosts7d: Number(ownPosts7d?.n ?? 0),
    competitorCount,
    competitorHits,
    competitorWeeklyMedian: weekly?.weekly == null ? null : Number(weekly.weekly),
    siteOffer: offerRow
      ? {
        jobId: Number(offerRow.job_id),
        domain: offerRow.domain,
        answer: offerRow.answer,
        landing: landingRow?.answer ?? null,
      }
      : null,
    audienceQuestion: audienceRow
      ? {
        id: Number(audienceRow.id),
        question: audienceRow.question,
        occurrences: Number(audienceRow.occurrences) || 1,
        lastSeenAt: audienceRow.last_seen_at,
      }
      : null,
    goal: briefRow?.goal ?? null,
    ownPublishedCount,
    latestDataAt,
    trackingStatus,
  };
}

async function loadWeekMoves(
  pool: Pick<Pool, "query">,
  channelId: number,
  weekStart: string,
): Promise<GrowthMoveRecord[]> {
  const rows = (
    await pool.query(
      `select id, week_start::text, kind, status, confidence, title, reason, prompt,
              action_href, source_kind, source_id, source_label, fingerprint, missing_slots,
              rank_position, evidence, artifact_draft_id, artifact_autopilot_plan_id
         from growth_moves
        where channel_id = $1 and week_start = $2::date
        order by rank_position nulls last, id`,
      [channelId, weekStart],
    )
  ).rows;
  return rows.map(mapMove);
}

type ArtifactRow = {
  move_id: number | string;
  draft_id: number | string | null;
  draft_scheduled_at: string | null;
  plan_id: number | string | null;
  plan_status: string | null;
  post_id: number | string | null;
  post_status: string | null;
  published_at: string | null;
  views: number | null;
  reactions: number | null;
  collected_at: string | null;
  tracking_status: string | null;
  tracked_link: boolean | null;
  conversions: number | string | null;
};

function outcomeCheckpoint(elapsedHours: number): 24 | 48 | 168 {
  if (elapsedHours < 24) return 24;
  if (elapsedHours < 48) return 48;
  return 168;
}

export function growthOutcomeFromScore(input: {
  artifactLabel: string;
  artifactHref: string | null;
  postId: number | null;
  publishedAt: string | null;
  views: number | null;
  reactions: number | null;
  conversions: number | null;
  trackingAvailable: boolean;
  collectedAt: string | null;
  scored: LibraryScoredItem | null;
  now?: Date;
}): GrowthOutcome {
  const now = input.now ?? new Date();
  const published = input.publishedAt ? new Date(input.publishedAt) : null;
  const elapsedHours = published && Number.isFinite(published.getTime())
    ? Math.max(0, Math.floor((now.getTime() - published.getTime()) / 3_600_000)) : 0;
  const maturity = !published ? "not_published"
    : elapsedHours < LIBRARY_FORMULA_DEFAULTS.maturityHours ? "collecting" : "mature";
  const sampleSize = input.scored?.cohortSampleSize ?? 0;
  const baselineViews = input.scored?.medianViews ?? null;
  const normalizedLift = input.scored?.lift ?? null;
  let conclusion: string;
  if (!published) {
    conclusion = "Материал ещё не опубликован — результата пока нет.";
  } else if (maturity === "collecting") {
    conclusion = "Первые цифры уже могут появиться, но делать вывод до контрольной точки рано.";
  } else if (input.views == null) {
    conclusion = "Публикация созрела для проверки, но платформа ещё не получила просмотры.";
  } else if (sampleSize < LIBRARY_FORMULA_DEFAULTS.minCohortSize || baselineViews == null || normalizedLift == null) {
    conclusion = `Пост собрал ${input.views} просмотров, но сопоставимая база пока слишком мала для уверенного вывода.`;
  } else if (normalizedLift >= 1.1) {
    conclusion = `Результат выше медианы сопоставимых постов в ${normalizedLift.toFixed(2)} раза. Наблюдение стоит повторить.`;
  } else if (normalizedLift <= 0.9) {
    conclusion = `Результат ниже медианы сопоставимых постов: ${normalizedLift.toFixed(2)} от базы. Это сигнал пересмотреть подачу, не приговор теме.`;
  } else {
    conclusion = "Результат близок к медиане сопоставимых постов — явного отличия пока нет.";
  }
  return {
    artifactLabel: input.artifactLabel,
    artifactHref: input.artifactHref,
    postId: input.postId,
    publishedAt: input.publishedAt,
    views: input.views,
    reactions: input.reactions,
    conversions: input.trackingAvailable ? input.conversions ?? 0 : null,
    trackingAvailable: input.trackingAvailable,
    sampleSize,
    baselineViews,
    normalizedLift,
    dataQuality: input.scored?.dataQuality ?? "low",
    maturity,
    checkpointHours: outcomeCheckpoint(elapsedHours),
    elapsedHours,
    collectedAt: input.collectedAt,
    conclusion,
    methodology: `Сопоставимые посты одного канала и формата за 90 дней; медиана, нормализованный результат и зрелость ${LIBRARY_FORMULA_DEFAULTS.maturityHours} ч. Формула ${LIBRARY_FORMULA_VERSION}.`,
  };
}

export function deriveGrowthLifecycle(input: {
  hasDraft: boolean;
  draftScheduledAt: string | null;
  hasPlan: boolean;
  postId: number | null;
  postStatus: string | null;
  outcomeMaturity: GrowthOutcome["maturity"] | null;
}): GrowthLifecycle {
  if (!input.hasDraft && !input.hasPlan) return "open";
  if (input.postId == null) {
    if (input.hasDraft && input.draftScheduledAt) return "scheduled";
    return input.hasPlan ? "plan_created" : "draft_created";
  }
  if (input.postStatus === "scheduled" || input.postStatus === "publishing") return "scheduled";
  if (input.outcomeMaturity === "collecting") return "collecting";
  if (input.outcomeMaturity === "mature") return "measured";
  if (input.outcomeMaturity != null) return "published";
  return input.hasPlan ? "plan_created" : "draft_created";
}

async function enrichMoveLifecycle(
  pool: Pick<Pool, "query">,
  input: { projectId: number; channelId: number; moves: GrowthMoveRecord[]; now?: Date },
): Promise<GrowthMoveRecord[]> {
  if (input.moves.length === 0) return [];
  const ids = input.moves.map((move) => move.id);
  const artifacts = (
    await pool.query<ArtifactRow>(
      `select move.id as move_id,
              draft.id as draft_id, draft.scheduled_at::text as draft_scheduled_at,
              plan.id as plan_id, plan.status as plan_status,
              post.id as post_id, post.status as post_status, post.published_at::text,
              stats.views, stats.reactions, stats.collected_at::text,
              tracking_settings.status as tracking_status,
              (tracking_snapshot.short_link_id is not null) as tracked_link,
              case when tracking_settings.status = 'active' and tracking_snapshot.short_link_id is not null
                then (select count(*)::int from conversion_events conversion
                       where conversion.project_id = move.project_id
                         and conversion.short_link_id = tracking_snapshot.short_link_id)
                else null end as conversions
         from growth_moves move
         left join drafts draft
           on draft.id = move.artifact_draft_id and draft.project_id = move.project_id
         left join autopilot_plan plan
           on plan.id = move.artifact_autopilot_plan_id and plan.project_id = move.project_id
         left join lateral (
           select candidate.* from posts candidate
            where candidate.project_id = move.project_id
              and candidate.channel_id = move.channel_id
              and (
                (draft.id is not null and candidate.publication_operation_id in (
                  select operation.id from publication_operations operation
                   where operation.project_id = move.project_id and operation.draft_id = draft.id
                ))
                or (plan.id is not null and candidate.id in (
                  select case when item->>'postId' ~ '^[0-9]+$' then (item->>'postId')::bigint end
                    from jsonb_array_elements(plan.items) item
                ))
              )
            order by candidate.published_at desc nulls last, candidate.scheduled_at desc nulls last, candidate.id
            limit 1
         ) post on true
         left join lateral (
           select snapshot.views, snapshot.reactions, snapshot.collected_at
             from post_stats snapshot
            where snapshot.project_id = move.project_id and snapshot.post_id = post.id
            order by snapshot.snapshot_date desc, snapshot.collected_at desc limit 1
         ) stats on true
         left join project_tracking_settings tracking_settings
           on tracking_settings.project_id = move.project_id
         left join lateral (
           select snapshot.short_link_id from publication_tracking_snapshots snapshot
            where snapshot.project_id = move.project_id and snapshot.post_id = post.id
              and snapshot.short_link_id is not null
            order by snapshot.id limit 1
         ) tracking_snapshot on true
        where move.project_id = $1 and move.channel_id = $2 and move.id = any($3::bigint[])`,
      [input.projectId, input.channelId, ids],
    )
  ).rows;

  const cohortRows = (
    await pool.query<{
      id: number | string; published_at: string; views: number | null; reactions: number | null; media: unknown;
    }>(
      `select post.id, post.published_at::text,
              stats.views, stats.reactions,
              case when post.media is null then 'text'
                   when post.media::text ilike '%video%' then 'video'
                   when post.media::text ilike '%photo%' or post.media::text ilike '%image%' then 'photo'
                   else 'text' end as media
         from posts post
         left join lateral (
           select snapshot.views, snapshot.reactions
             from post_stats snapshot
            where snapshot.project_id = post.project_id and snapshot.post_id = post.id
            order by snapshot.snapshot_date desc, snapshot.collected_at desc limit 1
         ) stats on true
        where post.project_id = $1 and post.channel_id = $2
          and post.status in ('published', 'published_unverified')
          and post.published_at >= now() - interval '90 days'`,
      [input.projectId, input.channelId],
    )
  ).rows;
  const scoringInput: LibraryScoringInput[] = cohortRows.map((row) => ({
    id: Number(row.id), channelId: input.channelId, sourceId: input.channelId,
    postedAt: row.published_at, views: row.views, reactions: row.reactions,
    media: typeof row.media === "string" ? row.media : "text",
  }));
  const scored = scoreLibraryCohorts(scoringInput, { now: input.now ?? new Date() });
  const scoreByPost = new Map(scored.map((item) => [Number(item.id), item]));
  const rowByMove = new Map(artifacts.map((row) => [Number(row.move_id), row]));

  return input.moves.map((move) => {
    const row = rowByMove.get(move.id);
    if (!row || move.status === "skipped" || move.status === "done") return move;
    const postId = row.post_id == null ? null : Number(row.post_id);
    const artifactLabel = row.plan_id != null ? "План недели"
      : row.draft_id != null ? "Черновик поста" : "Материал не создан";
    const artifactHref = row.draft_id != null ? `/app/composer?draft=${row.draft_id}`
      : row.plan_id != null ? `/app/autopilot?channel=${input.channelId}` : null;
    const hasDraft = row.draft_id != null;
    const hasPlan = row.plan_id != null;
    const outcome = hasDraft || hasPlan ? growthOutcomeFromScore({
      artifactLabel, artifactHref, postId,
      publishedAt: row.published_at,
      views: row.views == null ? null : Number(row.views),
      reactions: row.reactions == null ? null : Number(row.reactions),
      conversions: row.conversions == null ? null : Number(row.conversions),
      trackingAvailable: row.tracking_status === "active" && row.tracked_link === true,
      collectedAt: row.collected_at,
      scored: postId == null ? null : scoreByPost.get(postId) ?? null,
      now: input.now,
    }) : null;
    const lifecycle = deriveGrowthLifecycle({
      hasDraft,
      draftScheduledAt: row.draft_scheduled_at,
      hasPlan,
      postId,
      postStatus: row.post_status,
      outcomeMaturity: outcome?.maturity ?? null,
    });
    return { ...move, lifecycle, outcome };
  });
}

function buildReadiness(signals: GrowthSignals): GrowthReadinessItem[] {
  const items: GrowthReadinessItem[] = [];
  if (signals.competitorCount < 2) items.push({
    id: "competitors",
    title: signals.competitorCount === 1 ? "Добавь ещё одного конкурента" : "Добавь минимум двух конкурентов",
    body: "Аврора сможет отличать устойчивые темы и ритм от случайных залётов.",
    href: "/app/competitors",
    cta: "Добавить конкурентов",
  });
  if (!signals.siteOffer) items.push({
    id: "site", title: "Запусти разбор сайта",
    body: "Аврора увидит реальные услуги и сможет предлагать ходы на продажи без догадок.",
    href: "/app/site-analysis", cta: "Разобрать сайт",
  });
  if (signals.ownPublishedCount < LIBRARY_FORMULA_DEFAULTS.minCohortSize) items.push({
    id: "posts", title: `Накопи ещё ${LIBRARY_FORMULA_DEFAULTS.minCohortSize - signals.ownPublishedCount} публикаций`,
    body: "Аврора получит сопоставимую базу и сможет честно оценивать результат относительно медианы.",
    href: "/app/studio", cta: "Создать пост",
  });
  if (signals.trackingStatus !== "active") items.push({
    id: "tracking", title: "Подключи tracking",
    body: "Аврора сможет подтверждать переходы и заявки, а не принимать их отсутствие за ноль.",
    href: "/app/settings?section=tracking", cta: "Настроить tracking",
  });
  return items;
}

async function growthBoard(input: {
  actorUserId: number;
  channelId?: number | null;
}, ensure: boolean): Promise<GrowthBoard> {
  const pool = getPool();
  const membership = await requireSelectedProjectPermission(
    pool,
    input.actorUserId,
    ensure ? "content.create" : "project.read",
  );
  const channelId = await resolveChannel(
    { actorUserId: input.actorUserId, projectId: membership.projectId },
    input.channelId ?? null,
  );
  const weekStart = growthWeekStart();
  const previousWeekStart = previousGrowthWeekStart(weekStart);
  if (!channelId) {
    return {
      hasChannel: false,
      channelId: null,
      weekStart,
      previousWeekStart,
      diagnosis: [],
      moves: [],
      previousMoves: [],
      gaps: ["Подключи Telegram-канал — без него развитие считать не на чем."],
      goal: null,
      periodLabel: growthPeriodLabel(weekStart),
      completedMoves: 0,
      totalMoves: 0,
      dataFreshness: "Данные появятся после подключения канала",
      weeklyInsight: "Подключи канал — Аврора соберёт первые подтверждённые сигналы.",
      readiness: [],
      learning: { state: "collecting", text: "Пока собираем данные", basis: "Нужен хотя бы один завершённый ход." },
    };
  }

  const signals = await loadSignals(pool, {
    projectId: membership.projectId,
    channelId,
  });
  const { diagnosis, gaps } = buildGrowthDiagnosis(signals);

  let moves: GrowthMoveRecord[];
  if (!ensure) {
    moves = await loadWeekMoves(pool, channelId, weekStart);
  } else {
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `growth:${channelId}:${weekStart}`,
      ]);
      const existing = await loadWeekMoves(client, channelId, weekStart);
      const incompleteLegacySet = existing.some((move) => move.actionHref === "/app/growth");
      if (existing.length === 0 || incompleteLegacySet) {
        const drafts = buildGrowthMoves(signals);
        for (const draft of drafts) {
          await client.query(
            `insert into growth_moves (
               project_id, channel_id, week_start, kind, status, confidence,
               title, reason, prompt, action_href, source_kind, source_id,
               source_label, fingerprint, missing_slots, rank_position, evidence
             ) values (
               $1, $2, $3::date, $4, 'open', $5,
               $6, $7, $8, '/app/growth', $9, $10,
               $11, $12, $13, $14, $15::jsonb
             )
             on conflict (channel_id, week_start, fingerprint) do nothing`,
            [
              membership.projectId,
              channelId,
              weekStart,
              draft.kind,
              draft.confidence,
              clip(draft.title, 200),
              clip(draft.reason, 500),
              clip(draft.prompt, 2000),
              draft.sourceKind,
              draft.sourceId,
              draft.sourceLabel,
              draft.fingerprint,
              draft.missingSlots,
              draft.rankPosition ?? null,
              JSON.stringify(draft.evidence),
            ],
          );
        }
      }
      moves = await loadWeekMoves(client, channelId, weekStart);
      let actionHrefUpdated = false;
      for (const move of moves) {
        const href = growthActionHref({
          id: move.id,
          kind: move.kind,
          channelId,
          sourceId: move.sourceId,
        });
        if (move.actionHref === href) continue;
        await client.query(
          `update growth_moves
              set action_href = $2, updated_at = now()
            where id = $1 and project_id = $3 and channel_id = $4`,
          [move.id, href, membership.projectId, channelId],
        );
        actionHrefUpdated = true;
      }
      if (actionHrefUpdated) {
        moves = await loadWeekMoves(client, channelId, weekStart);
      }
      await client.query("commit");
    } catch (error) {
      if (client) await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client?.release();
    }
  }

  moves = await enrichMoveLifecycle(pool, {
    projectId: membership.projectId,
    channelId,
    moves,
  });
  const previousMoves = await enrichMoveLifecycle(pool, {
    projectId: membership.projectId,
    channelId,
    moves: await loadWeekMoves(pool, channelId, previousWeekStart),
  });
  for (const move of [...moves, ...previousMoves]) {
    const postId = move.outcome?.postId;
    if (!postId || !move.outcome?.publishedAt) continue;
    await pool.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id, safe_data, idempotency_key)
       values ($1, $2, 'growth.artifact.published', 'growth_move', $3, $4::jsonb, $5)
       on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
      [membership.projectId, input.actorUserId, String(move.id),
        JSON.stringify({ postId, kind: move.kind }), `growth:move:${move.id}:post:${postId}:published`],
    );
    if (move.lifecycle === "measured") {
      await pool.query(
        `insert into audit_events
           (project_id, actor_user_id, action, entity_type, entity_id, safe_data, idempotency_key)
         values ($1, $2, 'growth.outcome.measured', 'growth_move', $3, $4::jsonb, $5)
         on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
        [membership.projectId, input.actorUserId, String(move.id),
          JSON.stringify({ postId, sampleSize: move.outcome.sampleSize, dataQuality: move.outcome.dataQuality }),
          `growth:move:${move.id}:post:${postId}:measured`],
      );
    }
  }
  const completedMoves = moves.filter((move) =>
    !["open", "skipped"].includes(move.lifecycle)).length;
  const primary = moves.find((move) => !["skipped", "done", "measured"].includes(move.lifecycle));
  const learned = previousMoves.find((move) =>
    move.outcome?.maturity === "mature"
      && move.outcome.views != null
      && move.outcome.sampleSize >= LIBRARY_FORMULA_DEFAULTS.minCohortSize);
  return {
    hasChannel: true,
    channelId,
    weekStart,
    previousWeekStart,
    diagnosis,
    moves,
    previousMoves,
    gaps,
    goal: signals.goal,
    periodLabel: growthPeriodLabel(weekStart),
    completedMoves,
    totalMoves: moves.length,
    dataFreshness: signals.latestDataAt ? humanFreshness(signals.latestDataAt) : "Свежесть источников неизвестна",
    weeklyInsight: primary?.reason
      ?? (moves.length ? "Ходы недели закрыты. Аврора продолжает собирать результат." : "Пока не хватает подтверждённых сигналов для нового хода."),
    readiness: buildReadiness(signals),
    learning: learned?.outcome
      ? { state: "ready", text: learned.outcome.conclusion, basis: `${learned.title} · ${learned.outcome.methodology}` }
      : { state: "collecting", text: "Пока собираем данные", basis: "Вывод появится после зрелого результата с сопоставимой базой." },
  };
}

export async function loadGrowthBoard(input: {
  actorUserId: number;
  channelId?: number | null;
}): Promise<GrowthBoard> {
  return growthBoard(input, false);
}

export async function ensureGrowthBoard(input: {
  actorUserId: number;
  channelId?: number | null;
}): Promise<GrowthBoard> {
  return growthBoard(input, true);
}

export async function getGrowthMove(input: {
  actorUserId: number;
  moveId: number;
}): Promise<GrowthMoveRecord | null> {
  if (!Number.isSafeInteger(input.moveId) || input.moveId <= 0) return null;
  const pool = getPool();
  const membership = await requireSelectedProjectPermission(pool, input.actorUserId, "project.read");
  const row = (
    await pool.query(
      `select id, week_start::text, kind, status, confidence, title, reason, prompt,
              action_href, source_kind, source_id, source_label, fingerprint, missing_slots,
              rank_position, evidence, artifact_draft_id, artifact_autopilot_plan_id
         from growth_moves
        where id = $1 and project_id = $2`,
      [input.moveId, membership.projectId],
    )
  ).rows[0];
  return row ? mapMove(row) : null;
}

export async function updateGrowthMoveStatus(input: {
  actorUserId: number;
  moveId: number;
  status: Exclude<GrowthMoveStatus, "open">;
}): Promise<GrowthMoveRecord | null> {
  const current = await getGrowthMove(input);
  if (!current) return null;
  const pool = getPool();
  const membership = await requireSelectedProjectPermission(pool, input.actorUserId, "content.edit");
  const row = (
    await pool.query(
      `update growth_moves
          set status = $3, updated_at = now()
        where id = $1 and project_id = $2
        returning id, week_start::text, kind, status, confidence, title, reason, prompt,
                  action_href, source_kind, source_id, source_label, fingerprint, missing_slots,
                  rank_position, evidence, artifact_draft_id, artifact_autopilot_plan_id`,
      [input.moveId, membership.projectId, input.status],
    )
  ).rows[0];
  if (row && input.status === "skipped") {
    await pool.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id, safe_data,
          idempotency_key)
       values ($1, $2, 'growth.move.skipped', 'growth_move', $3, $4::jsonb, $5)
       on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
      [
        membership.projectId,
        input.actorUserId,
        String(input.moveId),
        JSON.stringify({ kind: current.kind }),
        `growth:move:${input.moveId}:skipped`,
      ],
    );
  }
  return row ? mapMove(row) : null;
}

export class GrowthArtifactLinkError extends Error {
  constructor(public readonly code: "growth_move_not_found" | "growth_move_conflict") {
    super(code);
    this.name = "GrowthArtifactLinkError";
  }
}

export async function linkGrowthMoveDraftInTransaction(input: {
  db: Pick<PoolClient, "query">;
  projectId: number;
  actorUserId: number;
  moveId: number;
  draftId: number;
  channelIds: readonly number[];
}): Promise<void> {
  const move = (
    await input.db.query<{ id: string; channel_id: string; kind: GrowthMoveKind; status: GrowthMoveStatus; artifact_draft_id: string | null }>(
      `select id, channel_id, kind, status, artifact_draft_id
         from growth_moves where id = $1 and project_id = $2 for update`,
      [input.moveId, input.projectId],
    )
  ).rows[0];
  if (!move || move.status !== "open" || move.kind === "rhythm" || !input.channelIds.includes(Number(move.channel_id))) {
    throw new GrowthArtifactLinkError("growth_move_not_found");
  }
  if (move.artifact_draft_id != null && Number(move.artifact_draft_id) !== input.draftId) {
    throw new GrowthArtifactLinkError("growth_move_conflict");
  }
  await input.db.query(
    `update growth_moves
        set artifact_draft_id = $3, updated_at = now()
      where id = $1 and project_id = $2
        and artifact_autopilot_plan_id is null`,
    [input.moveId, input.projectId, input.draftId],
  );
  await input.db.query(
    `insert into audit_events
       (project_id, actor_user_id, action, entity_type, entity_id, safe_data, idempotency_key)
     values ($1, $2, 'growth.artifact.created', 'growth_move', $3, $4::jsonb, $5)
     on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
    [
      input.projectId, input.actorUserId, String(input.moveId),
      JSON.stringify({ artifactType: "draft", artifactId: input.draftId, kind: move.kind }),
      `growth:move:${input.moveId}:draft:${input.draftId}`,
    ],
  );
}

export async function linkGrowthMovePlanInTransaction(input: {
  db: Pick<PoolClient, "query">;
  projectId: number;
  actorUserId: number;
  moveId: number;
  planId: number;
  channelId: number;
}): Promise<void> {
  const updated = await input.db.query<{ kind: GrowthMoveKind }>(
    `update growth_moves
        set artifact_autopilot_plan_id = $4, updated_at = now()
      where id = $1 and project_id = $2 and channel_id = $3 and kind = 'rhythm'
        and status = 'open'
        and artifact_draft_id is null
        and (artifact_autopilot_plan_id is null or artifact_autopilot_plan_id = $4)
      returning kind`,
    [input.moveId, input.projectId, input.channelId, input.planId],
  );
  if (!updated.rowCount) throw new GrowthArtifactLinkError("growth_move_conflict");
  await input.db.query(
    `insert into audit_events
       (project_id, actor_user_id, action, entity_type, entity_id, safe_data, idempotency_key)
     values ($1, $2, 'growth.artifact.created', 'growth_move', $3, $4::jsonb, $5)
     on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
    [
      input.projectId, input.actorUserId, String(input.moveId),
      JSON.stringify({ artifactType: "autopilot_plan", artifactId: input.planId, kind: "rhythm" }),
      `growth:move:${input.moveId}:plan:${input.planId}`,
    ],
  );
}

export const GROWTH_TELEMETRY_EVENTS = [
  "growth.board.viewed",
  "growth.evidence.opened",
  "growth.move.started",
] as const;
export type GrowthTelemetryEvent = (typeof GROWTH_TELEMETRY_EVENTS)[number];

export async function recordGrowthTelemetry(input: {
  actorUserId: number;
  event: GrowthTelemetryEvent;
  moveId?: number | null;
  channelId?: number | null;
}): Promise<void> {
  const pool = getPool();
  const membership = await requireSelectedProjectPermission(pool, input.actorUserId, "project.read");
  if (input.moveId) {
    const allowed = await pool.query(
      `select 1 from growth_moves where id = $1 and project_id = $2
        and ($3::bigint is null or channel_id = $3)`,
      [input.moveId, membership.projectId, input.channelId ?? null],
    );
    if (!allowed.rowCount) throw new GrowthArtifactLinkError("growth_move_not_found");
  }
  await pool.query(
    `insert into audit_events
       (project_id, actor_user_id, action, entity_type, entity_id, safe_data)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      membership.projectId,
      input.actorUserId,
      input.event,
      input.moveId ? "growth_move" : "growth_board",
      input.moveId ? String(input.moveId) : input.channelId ? String(input.channelId) : null,
      JSON.stringify({ channelId: input.channelId ?? null }),
    ],
  );
}

export function isGrowthAccessError(error: unknown): boolean {
  return error instanceof ProjectAccessError;
}
