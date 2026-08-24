"use client";

// А10. Автопилот (ТЗ 5.6, Д.9). ИИ собирает план недели по аналитике (Д.5) и залётам (Д.7),
// в стиле пользователя. Одобрил — посты уходят в ту же очередь публикации (Д.3). Настоящие
// данные, никаких фейков: нет движка/аналитики — честно помечаем.

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  BarChart3,
  CalendarCheck,
  CalendarDays,
  Check,
  ChevronDown,
  Clock,
  Eye,
  Loader2,
  Newspaper,
  Pause,
  Pencil,
  Play,
  Rocket,
  Send,
  Settings2,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { AppShell } from "@/components/app/shell";
import { EvidenceCard } from "@/components/app/evidence-card";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { RUBRICS, type Brief } from "@/lib/brief";
import {
  hasHumanQualityAttestation,
  hasVerifiedQualityMetadata,
  type QualityResult,
} from "@/lib/post-quality.mjs";
import {
  isAutopilotHumanReviewItem,
  isAutopilotReaderReadyItem,
} from "@/lib/autopilot-review.mjs";
import type { ApprovalBlocker, AutopilotApprovalPreview } from "@/lib/autopilot-approval.mjs";
import {
  estimateAutopilotBuildMinutes,
  type AutopilotBuildMinuteEstimate,
} from "@/lib/autopilot-build-progress.mjs";
import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import {
  AUTOPILOT_ENGINE_OPTIONS,
  DEFAULT_AUTOPILOT_PLANNING_WEEKS,
  DEFAULT_AUTOPILOT_ENGINE,
  MAX_AUTOPILOT_PLANNING_WEEKS,
  MIN_AUTOPILOT_PLANNING_WEEKS,
  plannedDailyAutopilotPostCount,
  plannedPostCountForWeeks,
} from "@/lib/autopilot-config.mjs";
import {
  DEFAULT_AUTOPILOT_QUICK_SETTINGS,
  normalizeAutopilotQuickSettings,
  type AutopilotQuickSettings,
} from "@/lib/autopilot-style.mjs";
import { sanitizeAutopilotPublicText } from "@/lib/autopilot-publication.mjs";
import { autopilotCandidateCount } from "@/lib/autopilot-candidate-selection.mjs";
import { autopilotBuildSpinnerClass } from "@/lib/autopilot-build-ui.mjs";
import type { RealPost } from "@/lib/types";
import { cn, fmtCompact, plural } from "@/lib/utils";

interface PlanItem {
  i: number;
  scheduledAt: string;
  topic: string;
  rubric?: string | null; // рубрика из брифа — по ней берём иконку
  draft: string;
  status: "pending" | "approved" | "rejected" | "published" | "expired";
  aiReady?: boolean;
  // На чём основан пост: куски базы знаний. Это доказательство, что цифры не выдуманы,
  // а взяты из материалов автора. Пусто — пост написан без конкретики (её нечем подпереть).
  sources?: {
    id: number | string;
    text: string;
    kind?: string;
    title?: string;
    url?: string;
    publishedAt?: string;
  }[];
  // Конкретика, которой нет в базе: она может остаться в старом плане или после ручной
  // правки. Новая автоматическая сборка такой пост готовым уже не считает.
  invented?: string[];
  qualityBlocked?: boolean;
  quality?: QualityResult;
  qualityOrigin?: string;
  approvalBlockers?: ApprovalBlocker[];
  reviewRequired?: boolean;
  reviewState?: "semantic_only_review" | "editorial_review" | "quality_review";
  reviewReason?: string;
  draftId?: number;
}
interface Settings {
  enabled: boolean;
  mode: "confirm" | "full";
  post_frequency: number;
  approvals_streak: number;
  generation_engine: string;
  planning_months: number;
  planning_weeks: number;
  quick_settings: AutopilotQuickSettings;
}
interface ActivePlan {
  id: number;
  revision: number;
  items: PlanItem[];
  rules: string | null;
  status: "pending" | "approved" | "approving";
  generationEngine: string;
  planningMonths: number;
  planningWeeks: number;
  expectedPostCount: number;
  publicationTargetCount: number;
  candidateCount: number;
  quickSettings?: AutopilotQuickSettings;
}
interface BuildAttempt {
  planId: number;
  revision: number;
  status: "building" | "partial" | "error";
  targetCount: number;
  publicationTargetCount: number;
  candidateCount: number;
  readyCount: number;
  failedCount: number;
  progress: {
    completed: number;
    total: number;
    reviewRequired: number;
    ready: number;
    failed: number;
    percent: number;
    stage: "preparing" | "generating" | "finalizing";
  };
  causes: {
    code: string;
    count: number;
    title: string;
    action: string;
    publicationDisposition: "ready" | "confirmation_required" | "blocked";
    repairStrategy: string;
  }[];
  primaryFix:
    | "deterministic_format"
    | "rewrite"
    | "add_knowledge"
    | "human_review"
    | "provider_retry"
    | "settings_change"
    | null;
  recoveryState: "waiting_provider" | "provider_stopped" | null;
  providerFailureCode: string | null;
  attemptNumber: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  retryableItemIndexes: number[];
  readerReadyItems: PlanItem[];
  errorReason?:
    | "timeout"
    | "quota"
    | "variety"
    | "quality"
    | "knowledge"
    | "sources"
    | "provider"
    | "cancelled"
    | null;
  updatedAt: string;
}
interface State {
  settings: Settings | null;
  plan: ActivePlan | null;
  activePlan: ActivePlan | null;
  buildAttempt: BuildAttempt | null;
  hasChannel: boolean;
  brief: Brief | null;
  briefReady: boolean;
  channelId: number | null;
}

interface OverviewPostStat {
  id: number;
  published_at: string;
  views: number | null;
  reactions: number | null;
}

interface OverviewStats {
  posts?: OverviewPostStat[];
  available?: { views?: boolean; reactions?: boolean; reach?: boolean };
}

const MSK = "Europe/Moscow";
const fmtDayMsk = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { timeZone: MSK, weekday: "short", day: "numeric" });
const fmtTimeMsk = (iso: string) =>
  new Date(iso).toLocaleTimeString("ru-RU", { timeZone: MSK, hour: "2-digit", minute: "2-digit" });
const fmtRangeMsk = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { timeZone: MSK, day: "numeric", month: "short" });

const moscowDateKey = (value: string | Date) => {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: MSK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
};

const shiftDateKey = (key: string, days: number) => {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const mondayDateKey = (value: string | Date) => {
  const key = moscowDateKey(value);
  const date = new Date(`${key}T12:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  return shiftDateKey(key, 1 - weekday);
};

const dateForKey = (key: string) => new Date(`${key}T12:00:00Z`);

const realPostMediaUrl = (media: unknown): string | null => {
  if (!media || typeof media !== "object") return null;
  const record = media as Record<string, unknown>;
  if (typeof record.url === "string" && record.url) return record.url;
  if (Array.isArray(record.items)) {
    const first = record.items.find((item) => (
      item && typeof item === "object" && typeof (item as Record<string, unknown>).url === "string"
    )) as Record<string, unknown> | undefined;
    return typeof first?.url === "string" ? first.url : null;
  }
  return null;
};

const realPostUrl = (post: RealPost): string | null => {
  if (post.status !== "published" || post.verification_state !== "verified") return null;
  if (post.network === "vk" && post.vk_group_id != null && post.vk_post_id != null) {
    return `https://vk.com/wall-${post.vk_group_id}_${post.vk_post_id}`;
  }
  if (post.network === "tg" && post.handle && post.tg_message_id != null) {
    return `https://t.me/${post.handle.replace(/^@/, "")}/${post.tg_message_id}`;
  }
  return null;
};

const fmtBuildEstimate = ({ min, max }: AutopilotBuildMinuteEstimate) => {
  if (max <= 0) return "меньше минуты";
  if (min === max) {
    return max === 1 ? "около минуты" : `около ${max} минут`;
  }
  return `примерно ${min}–${max} ${plural(max, "минута", "минуты", "минут")}`;
};

const hasPassedVerifiedQuality = (item: PlanItem) =>
  item.aiReady !== false &&
  hasVerifiedQualityMetadata(item.quality) &&
  item.quality?.passed === true &&
  item.qualityBlocked !== true;

const canApproveItem = (item: PlanItem) =>
  hasPassedVerifiedQuality(item) || isAutopilotHumanReviewItem(item);

// Иконка поста. Сначала — точная, по рубрике из брифа; если рубрики нет
// (например, тема пришла из залётов конкурентов) — угадываем по словам темы.
const RUBRIC_ICONS = new Map(RUBRICS.map((r) => [r.label, r.emoji]));
const TOPIC_ICONS: [RegExp, string][] = [
  [/новост|событ|анонс|изменен|исследован/i, "🗞️"],
  [/совет|полезн/i, "💡"],
  [/истори|личн/i, "📖"],
  [/ошибк|разбор/i, "⚠️"],
  [/вопрос/i, "❓"],
  [/итог|недел|подборк/i, "📊"],
  [/инструкц|шаг/i, "📋"],
  [/кейс/i, "🔍"],
  [/миф|правд/i, "🎭"],
  [/видео|сценар|кулис/i, "🎬"],
];
function topicIcon(topic: string, rubric?: string | null): string {
  if (rubric && RUBRIC_ICONS.has(rubric)) return RUBRIC_ICONS.get(rubric)!;
  for (const [re, icon] of TOPIC_ICONS) if (re.test(topic)) return icon;
  return "✨";
}

const plainPostText = (value: string) =>
  sanitizeAutopilotPublicText(value).replace(/\*\*([^*]+)\*\*/gu, "$1");

function PostPreview({ text, expanded }: { text: string; expanded: boolean }) {
  const clean = sanitizeAutopilotPublicText(text);
  if (!expanded) {
    return (
      <p className="line-clamp-2 max-w-[68ch] text-[14px] leading-relaxed text-text-2">
        {plainPostText(clean)}
      </p>
    );
  }

  return (
    <div className="max-w-[68ch] space-y-3 text-[14px] leading-relaxed text-text-2">
      {clean.split(/\n{2,}/u).filter(Boolean).map((paragraph, paragraphIndex) => (
        <p key={`${paragraph.slice(0, 32)}-${paragraphIndex}`} className="whitespace-pre-line">
          {paragraph.split(/(\*\*[^*]+\*\*)/u).map((part, partIndex) =>
            part.startsWith("**") && part.endsWith("**") ? (
              <strong key={`${partIndex}-${part}`} className="font-semibold text-text">
                {part.slice(2, -2)}
              </strong>
            ) : (
              part
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function AutopilotHero({
  enabled,
  building,
  hasPlan,
  busy,
  blocked,
  onToggle,
}: {
  enabled: boolean;
  building: boolean;
  hasPlan: boolean;
  busy: boolean;
  blocked: boolean;
  onToggle: () => void;
}) {
  const status = enabled ? "Автопилот активен" : "Автопилот на паузе";
  const title = building
    ? "Контент-план собирается"
    : enabled && hasPlan
      ? "Контент создаётся и публикуется"
      : enabled
        ? "Автопилот готов к работе"
        : "Новые планы приостановлены";
  const description = building
    ? "Аврора подбирает темы, пишет посты и проверяет их перед добавлением в расписание."
    : enabled
      ? "Аврора подбирает темы, готовит посты и публикует их по подтверждённому расписанию."
      : "Уже запланированные публикации остаются в календаре. Возобновите Автопилот, когда будете готовы.";

  return (
    <Card
      as="section"
      aria-labelledby="autopilot-hero-title"
      className="relative overflow-hidden bg-info-soft p-0 ring-1 ring-brand/10"
    >
      <div className="relative z-10 flex min-h-[14.75rem] max-w-[48rem] flex-col items-start justify-center p-5 sm:p-7 lg:p-8">
        <Badge tone={enabled ? "success" : "neutral"} className="gap-1.5 px-3 py-1.5">
          {status}
          <span className={cn("h-1.5 w-1.5 rounded-full", enabled ? "bg-success" : "bg-text-3")} aria-hidden />
        </Badge>
        <h2 id="autopilot-hero-title" className="mt-5 text-balance text-[22px] font-extrabold leading-tight tracking-tight text-text sm:text-[25px]">
          {title}
        </h2>
        <p className="mt-2 max-w-[60ch] text-pretty text-[14px] leading-relaxed text-text-2">
          {description}
        </p>
        <Button
          type="button"
          variant="outline"
          size="md"
          onClick={onToggle}
          loading={busy}
          disabled={busy || blocked || building}
          className="mt-6 bg-surface/85"
        >
          {enabled ? (
            <Pause className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
          ) : (
            <Play className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
          )}
          {enabled ? "Приостановить" : "Возобновить"}
        </Button>
      </div>

      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[42%] overflow-hidden sm:block" aria-hidden>
        <div className="absolute top-2 right-3 h-52 w-52 rounded-full bg-brand/10 blur-2xl" />
        <div className="absolute top-9 right-[18%] grid h-32 w-32 rotate-12 place-items-center rounded-full bg-surface/70 shadow-card ring-1 ring-white/50 backdrop-blur-md lg:h-36 lg:w-36">
          <Rocket className="h-20 w-20 -translate-y-1 text-brand drop-shadow-[0_14px_18px_color-mix(in_oklch,var(--brand-1)_24%,transparent)] lg:h-24 lg:w-24" strokeWidth={1.55} />
        </div>
        <div className="absolute right-[-4rem] bottom-[-5rem] h-40 w-[30rem] rounded-[50%] bg-surface shadow-soft" />
        <div className="absolute right-[18rem] bottom-[-3rem] h-28 w-28 rounded-full bg-surface" />
        <div className="absolute right-[10rem] bottom-[-2rem] h-36 w-36 rounded-full bg-surface" />
        <div className="absolute right-[2rem] bottom-[-3rem] h-32 w-32 rounded-full bg-surface" />
      </div>
    </Card>
  );
}

function OverviewMetricCard({
  icon,
  label,
  value,
  note,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note: string;
  tone: "brand" | "success" | "violet";
}) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-4">
        <span
          style={tone === "violet" ? {
            backgroundColor: "color-mix(in oklch, oklch(0.65 0.18 292) 14%, var(--surface))",
            color: "color-mix(in oklch, oklch(0.68 0.2 292) 78%, var(--text))",
          } : undefined}
          className={cn(
            "flex h-14 w-14 shrink-0 items-center justify-center rounded-md",
            tone === "brand" && "bg-brand/10 text-brand",
            tone === "success" && "bg-success-soft text-success-text",
          )}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-text-3">{label}</p>
          <p className="nums mt-1 text-[25px] font-extrabold leading-none tracking-tight text-text tabular-nums">{value}</p>
          <p className="mt-1.5 text-[12px] leading-snug text-text-3">{note}</p>
        </div>
      </div>
    </Card>
  );
}

interface OverviewScheduleDay {
  key: string;
  weekday: string;
  date: number;
  items: PlanItem[];
}

function WeekSchedule({ days }: { days: OverviewScheduleDay[] }) {
  return (
    <Card as="section" className="overflow-hidden p-0" aria-labelledby="autopilot-schedule-title">
      <div className="p-4 pb-0 sm:p-5 sm:pb-0">
        <h2 id="autopilot-schedule-title" className="text-[17px] font-extrabold tracking-tight text-text">
          Расписание публикаций
        </h2>
      </div>
      <div className="mt-4 overflow-x-auto overscroll-x-contain px-4 pb-2 sm:px-5">
        <div className="grid min-w-[54rem] grid-cols-7 lg:min-w-0">
          {days.map((day, index) => {
            const item = day.items[0];
            const published = item?.status === "published";
            const scheduled = item?.status === "approved";
            const status = published
              ? "Опубликовано"
              : scheduled
                ? "Запланировано"
                : item
                  ? "Готово к просмотру"
                  : null;
            return (
              <div key={day.key} className={cn("min-w-0 px-3 py-1 first:pl-0 last:pr-0", index > 0 && "border-l border-line")}>
                <p className="text-[13px] font-bold capitalize text-text-2">
                  {day.weekday} <span className="nums ml-1 text-text-3 tabular-nums">{day.date}</span>
                </p>
                {item ? (
                  <div className="mt-5 min-h-[6.75rem]">
                    <p className="nums text-[13px] font-extrabold text-text tabular-nums">{fmtTimeMsk(item.scheduledAt)}</p>
                    <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-text-2">{item.topic}</p>
                    {status && (
                      <p className={cn("mt-2 flex items-center gap-1.5 text-[12px] font-semibold", published ? "text-success-text" : "text-brand")}>
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", published ? "bg-success" : "bg-brand")} aria-hidden />
                        {status}
                      </p>
                    )}
                    {day.items.length > 1 && (
                      <p className="mt-1 text-[12px] text-text-3">Ещё {day.items.length - 1}</p>
                    )}
                  </div>
                ) : (
                  <div className="mt-5 min-h-[6.75rem]">
                    <p className="text-[13px] text-text-3">—</p>
                    <p className="mt-1 text-[13px] text-text-3">{index >= 5 ? "Выходной" : "Нет публикаций"}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="p-4 pt-2 sm:p-5 sm:pt-3">
        <Link href="/app/calendar" className={buttonClassName({ variant: "outline", size: "sm" })}>
          <CalendarDays className="h-4 w-4" strokeWidth={2} aria-hidden />
          Смотреть полный календарь
        </Link>
      </div>
    </Card>
  );
}

function RecentPublicationCard({ post }: { post: RealPost }) {
  const mediaUrl = realPostMediaUrl(post.media);
  const href = realPostUrl(post);
  const publishedAt = post.published_at ?? post.scheduled_at ?? post.created_at;
  const content = (
    <>
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="nums text-[12px] text-text-3 tabular-nums">
            {new Date(publishedAt).toLocaleDateString("ru-RU", { timeZone: MSK, weekday: "short", day: "numeric", month: "short" })}
            {" · "}
            {fmtTimeMsk(publishedAt)}
          </p>
          <h3 className="mt-2 line-clamp-3 text-[14px] font-bold leading-snug text-text">
            {plainPostText(post.text)}
          </h3>
        </div>
        {mediaUrl ? (
          <Image
            src={mediaUrl}
            alt=""
            width={80}
            height={80}
            unoptimized
            loading="lazy"
            className="h-20 w-20 shrink-0 rounded-sm object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
          />
        ) : (
          <span className="grid h-20 w-20 shrink-0 place-items-center rounded-sm bg-info-soft text-brand outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10" aria-hidden>
            <Send className="h-7 w-7" strokeWidth={1.6} />
          </span>
        )}
      </div>
      <p className="mt-auto flex items-center gap-1.5 pt-4 text-[12px] font-semibold text-success-text">
        <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
        Опубликовано
      </p>
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-h-[10.25rem] flex-col rounded-md bg-surface p-4 shadow-soft ring-1 ring-line transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none"
        aria-label={`Открыть опубликованный пост: ${plainPostText(post.text).slice(0, 80)}`}
      >
        {content}
      </a>
    );
  }

  return <article className="flex min-h-[10.25rem] flex-col rounded-md bg-surface p-4 shadow-soft ring-1 ring-line">{content}</article>;
}

function RecentPublications({ posts, loading }: { posts: RealPost[]; loading: boolean }) {
  return (
    <Card
      as="section"
      className="p-4 sm:p-5"
      aria-labelledby="autopilot-recent-title"
      aria-busy={loading}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="autopilot-recent-title" className="text-[17px] font-extrabold tracking-tight text-text">
          Последние публикации
        </h2>
        <Link href="/app/calendar" className={buttonClassName({ variant: "outline", size: "sm" })}>
          Смотреть все
        </Link>
      </div>
      {loading ? (
        <div className="mt-4 grid gap-3 md:grid-cols-3" role="status" aria-label="Загружаются последние публикации">
          <div className="skeleton h-[10.25rem] rounded-md" />
          <div className="skeleton h-[10.25rem] rounded-md" />
          <div className="skeleton h-[10.25rem] rounded-md" />
        </div>
      ) : posts.length > 0 ? (
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {posts.map((post) => <RecentPublicationCard key={post.id} post={post} />)}
        </div>
      ) : (
        <div className="mt-4 rounded-sm bg-surface-inset p-4">
          <p className="text-[14px] font-semibold text-text">Публикаций Автопилота пока нет</p>
          <p className="mt-1 max-w-[60ch] text-[13px] leading-relaxed text-text-2">
            После первой подтверждённой публикации здесь появятся реальные результаты и ссылки на посты.
          </p>
        </div>
      )}
    </Card>
  );
}

function QuickRange({
  id,
  label,
  hint,
  min,
  max,
  value,
  valueLabel,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  value: number;
  valueLabel: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const progress = ((value - min) / Math.max(1, max - min)) * 100;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-semibold text-text">
          {label}
        </label>
        <output htmlFor={id} className="shrink-0 text-[12px] font-semibold text-brand">
          {valueLabel}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        aria-valuetext={valueLabel}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ "--aurora-range-progress": `${progress}%` } as CSSProperties}
        className="aurora-range mt-2 h-11 w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
      />
      <p id={`${id}-hint`} className="mt-1 text-[12px] leading-snug text-text-3">
        {hint}
      </p>
    </div>
  );
}

function quickSettingsSummary(settings: AutopilotQuickSettings) {
  const detail = settings.detail === 1 ? "коротко" : settings.detail === 3 ? "подробно" : "оптимальный объём";
  const energy = settings.energy === 1 ? "спокойно" : settings.energy === 3 ? "живо" : "разговорно";
  const emoji = settings.emoji === 0 ? "без эмодзи" : settings.emoji === 2 ? "заметные эмодзи" : "умеренные эмодзи";
  return `${settings.newsPerWeek} ${plural(settings.newsPerWeek, "новость", "новости", "новостей")} в неделю · ${detail} · ${energy} · ${emoji}`;
}

function QuickSettingsDialog({
  open,
  settings,
  disabled,
  channelId,
  onChange,
  onClose,
}: {
  open: boolean;
  settings: AutopilotQuickSettings;
  disabled: boolean;
  channelId: number | null;
  onChange: (settings: AutopilotQuickSettings) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const restoreOpenerFocus = () => {
    const opener = openerRef.current;
    if (!opener?.isConnected) return;
    requestAnimationFrame(() => opener.focus());
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={disabled || undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        onClose();
        restoreOpenerFocus();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(680px,calc(100%-2rem))] overflow-y-auto rounded-lg border border-line bg-surface p-0 text-text shadow-card backdrop:bg-black/45"
    >
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-balance text-[18px] font-bold leading-tight text-text">
              Настройки постов
            </h2>
            <p id={descriptionId} className="mt-1 max-w-[60ch] text-pretty text-[13px] leading-relaxed text-text-3">
              Эти параметры применятся к следующей сборке. Факты, стоп-темы и правила канала останутся без изменений.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Закрыть настройки постов"
            onClick={onClose}
            className="shrink-0"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <fieldset disabled={disabled} className="mt-5">
          <legend className="sr-only">Параметры следующей сборки</legend>
          <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
            <QuickRange
              id="autopilot-news"
              label="Свежие события"
              hint="Остальные посты — полезные разборы и идеи по теме канала."
              min={0}
              max={7}
              value={settings.newsPerWeek}
              valueLabel={`${settings.newsPerWeek} из 7`}
              disabled={disabled}
              onChange={(newsPerWeek) => onChange({ ...settings, newsPerWeek })}
            />
            <QuickRange
              id="autopilot-detail"
              label="Желаемый объём"
              hint="Ориентир для текста, а не жёсткий лимит."
              min={1}
              max={3}
              value={settings.detail}
              valueLabel={settings.detail === 1 ? "коротко" : settings.detail === 3 ? "подробно" : "оптимально"}
              disabled={disabled}
              onChange={(detail) => onChange({ ...settings, detail })}
            />
            <QuickRange
              id="autopilot-energy"
              label="Подача"
              hint="Без канцелярита, редакторских комментариев и кликбейта."
              min={1}
              max={3}
              value={settings.energy}
              valueLabel={settings.energy === 1 ? "спокойно" : settings.energy === 3 ? "живо" : "разговорно"}
              disabled={disabled}
              onChange={(energy) => onChange({ ...settings, energy })}
            />
            <QuickRange
              id="autopilot-emoji"
              label="Эмодзи"
              hint="Эмодзи помогают чтению, но не заменяют смысл."
              min={0}
              max={2}
              value={settings.emoji}
              valueLabel={settings.emoji === 0 ? "без эмодзи" : settings.emoji === 2 ? "заметно" : "умеренно"}
              disabled={disabled}
              onChange={(emoji) => onChange({ ...settings, emoji })}
            />
          </div>
        </fieldset>

        <div className="mt-6 flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
          <Link
            href={`/app/settings${channelId ? `?channel=${channelId}` : ""}`}
            className={buttonClassName({ variant: "ghost", size: "sm", className: "justify-center sm:justify-start" })}
          >
            Настройки канала
          </Link>
          <Button type="button" variant="brand" onClick={onClose}>
            Готово
          </Button>
        </div>
      </div>
    </dialog>
  );
}

function BuildAttemptPanel({
  attempt,
  busy,
  reducedMotion,
  onContinue,
  onCancel,
  channelId,
}: {
  attempt: BuildAttempt;
  busy: boolean;
  reducedMotion: boolean | null;
  onContinue: () => void;
  onCancel: () => void;
  channelId: number | null;
}) {
  const readyCount = Math.min(attempt.readyCount, attempt.publicationTargetCount);
  const remaining = Math.max(0, attempt.publicationTargetCount - readyCount);
  const terminal = attempt.status !== "building";
  const waitingForProvider = attempt.status === "building" && attempt.recoveryState === "waiting_provider";
  const title = waitingForProvider
    ? "ИИ временно не ответил"
    : attempt.status === "building"
      ? `Готово ${readyCount} из ${attempt.publicationTargetCount}`
      : attempt.status === "partial"
        ? "Нужно дополнить план"
        : "Сборка остановилась";
  const description = waitingForProvider
    ? readyCount > 0
      ? `Готово ${readyCount} из ${attempt.publicationTargetCount}. Готовые посты сохранены; недостающие Аврора продолжит собирать автоматически.`
      : "Готовых постов пока нет. Аврора продолжит сборку автоматически, как только ИИ снова ответит."
    : attempt.status === "building"
      ? remaining > 0
        ? `Аврора пишет и проверяет ещё ${remaining} ${plural(remaining, "пост", "поста", "постов")}. Готовые тексты не пересобираются.`
        : "Тексты готовы. Аврора завершает проверку и раскладывает их по расписанию."
    : attempt.errorReason === "quota"
      ? "Дневной лимит генераций закончился до завершения плана. Запусти сборку после обновления лимита."
      : attempt.errorReason === "cancelled"
        ? "Сборка остановлена. Когда будешь готов, запусти её снова."
        : attempt.primaryFix === "add_knowledge"
          ? "По выбранным темам не хватило подтверждённых материалов. Добавь факты о канале и собери план снова."
          : attempt.recoveryState === "provider_stopped" || attempt.errorReason === "provider"
            ? readyCount > 0
              ? `Готово ${readyCount} из ${attempt.publicationTargetCount}. Готовые посты сохранены; продолжи сборку позже — Аврора возьмёт только недостающие.`
              : "Готовых постов пока нет. Продолжи сборку позже — Аврора снова попробует подготовить весь план."
            : readyCount > 0
              ? `Готово ${readyCount} из ${attempt.publicationTargetCount}. Продолжи сборку — готовые посты останутся без изменений.`
              : "Готовых постов пока нет. Продолжи сборку — Аврора снова попробует подготовить весь план.";
  const commonLinkClass = buttonClassName({
    variant: "primary",
    size: "sm",
    className: "w-full whitespace-normal text-center sm:w-auto",
  });

  return (
    <Card
      className="mb-5 overflow-hidden p-4 sm:p-5"
      role={terminal ? "alert" : "status"}
      aria-live={terminal ? "assertive" : "polite"}
      aria-atomic="true"
      aria-busy={attempt.status === "building" || undefined}
    >
      <div className="flex min-w-0 items-start gap-3">
        {attempt.status === "building" ? (
          <Loader2
            className={cn("mt-0.5 h-5 w-5 shrink-0 text-brand", autopilotBuildSpinnerClass(reducedMotion))}
            aria-hidden
          />
        ) : (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-snug text-text tabular-nums">{title}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-text-3">{description}</p>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {attempt.status === "building" ? (
              <Button variant="secondary" size="sm" onClick={onCancel} loading={busy} disabled={busy}>
                <X className="h-4 w-4" aria-hidden />
                Остановить сборку
              </Button>
            ) : attempt.primaryFix === "add_knowledge" ? (
              <Link href={`/app/knowledge${channelId ? `?channel=${channelId}` : ""}`} className={commonLinkClass}>
                Добавить материалы
              </Link>
            ) : attempt.primaryFix === "settings_change" ? (
              <Link href={`/app/settings${channelId ? `?channel=${channelId}` : ""}`} className={commonLinkClass}>
                Открыть настройки качества
              </Link>
            ) : (
              <Button variant="primary" size="sm" onClick={onContinue} loading={busy} disabled={busy}>
                Продолжить сборку
              </Button>
            )}
          </div>
        </div>
      </div>
      <div
        className="mt-4 h-2 overflow-hidden rounded-full bg-surface-inset"
        role="progressbar"
        aria-label="Прогресс сборки контент-плана"
        aria-valuemin={0}
        aria-valuemax={attempt.publicationTargetCount}
        aria-valuenow={readyCount}
      >
        <div
          className="h-full rounded-full bg-brand motion-reduce:transition-none"
          style={{ width: `${attempt.publicationTargetCount ? Math.round(readyCount / attempt.publicationTargetCount * 100) : 0}%` }}
        />
      </div>
    </Card>
  );
}

export default function AutopilotPage() {
  const s = useStore();
  const router = useRouter();
  const reduce = useReducedMotion();
  const [data, setData] = useState<State | null>(null);
  const [overviewStats, setOverviewStats] = useState<OverviewStats | null>(null);
  const [overviewStatsLoading, setOverviewStatsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autopilotToggleBusy, setAutopilotToggleBusy] = useState(false);
  const [editorBusyIndex, setEditorBusyIndex] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null); // какая карточка раскрыта целиком
  const [quickSettingsOpen, setQuickSettingsOpen] = useState(false);
  const [generationEngine, setGenerationEngine] = useState(DEFAULT_AUTOPILOT_ENGINE);
  const [planningWeeks, setPlanningWeeks] = useState(DEFAULT_AUTOPILOT_PLANNING_WEEKS);
  const [quickSettings, setQuickSettings] = useState<AutopilotQuickSettings>({
    ...DEFAULT_AUTOPILOT_QUICK_SETTINGS,
  });
  const [planningAnchorMs] = useState(Date.now);
  const [visibleLimit, setVisibleLimit] = useState(14);
  const approvalBusy = useRef(false);
  const loadSequence = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const activePlanIdentity = useRef<string | null>(null);
  const approvalAttempt = useRef<{
    planId: number;
    revision: number;
    hash: string;
    key: string;
  } | null>(null);
  // Выбранный канал. Список и выбор — как на «Конкурентах» и «Трендах»: общий компонент,
  // общий источник (стор), чтобы человек узнавал один и тот же элемент на всех экранах.
  const [picked, setPicked] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const value = Number(new URLSearchParams(window.location.search).get("channel"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  const { tgChannels, channelId: chId } = useChannelChoice(s.realChannels, picked);
  const [growthNotice, setGrowthNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const requestedChannelId = chId;
    const sequence = ++loadSequence.current;
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    try {
      const r = await fetch(`/api/autopilot${requestedChannelId ? `?channel=${requestedChannelId}` : ""}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const d = (await r.json().catch(() => null)) as (State & { error?: string }) | null;
      if (!r.ok || !d) throw new Error(d?.error || `http_${r.status}`);
      if (sequence !== loadSequence.current || controller.signal.aborted) return;
      if (requestedChannelId != null && d.channelId !== requestedChannelId) return;
      setLoadError(null);
      setData(d);
      if (d.settings) {
        setGenerationEngine(
          AUTOPILOT_ENGINE_OPTIONS.some((option) => option.id === d.settings?.generation_engine)
            ? d.settings.generation_engine as typeof DEFAULT_AUTOPILOT_ENGINE
            : DEFAULT_AUTOPILOT_ENGINE,
        );
        const savedWeeks = Number(d.settings.planning_weeks || d.settings.planning_months * 4);
        setPlanningWeeks(
          savedWeeks >= MIN_AUTOPILOT_PLANNING_WEEKS && savedWeeks <= MAX_AUTOPILOT_PLANNING_WEEKS
            ? savedWeeks
            : DEFAULT_AUTOPILOT_PLANNING_WEEKS,
        );
        setQuickSettings(normalizeAutopilotQuickSettings(d.settings.quick_settings));
      }
      const usablePlan = d.activePlan ?? d.plan;
      const nextPlanIdentity = usablePlan
        ? `${d.channelId}:${usablePlan.id}:${usablePlan.revision}`
        : null;
      if (activePlanIdentity.current !== nextPlanIdentity) setVisibleLimit(14);
      activePlanIdentity.current = nextPlanIdentity;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (sequence === loadSequence.current) {
        setLoadError("Не удалось загрузить Автопилот. Проверь подключение и повтори.");
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [chId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setData(null);
      setLoadError(null);
      setEditorBusyIndex(null);
      setExpanded(null);
      activePlanIdentity.current = null;
      void load();
    });
    return () => {
      cancelled = true;
      loadSequence.current += 1;
      loadAbort.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    if (!chId) {
      queueMicrotask(() => {
        if (cancelled) return;
        setOverviewStats(null);
        setOverviewStatsLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }
    const controller = new AbortController();
    queueMicrotask(() => {
      if (cancelled) return;
      setOverviewStats(null);
      setOverviewStatsLoading(true);
    });
    void fetch(`/api/stats?channel=${chId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as OverviewStats | null;
        if (response.ok && body) setOverviewStats(body);
      })
      .catch((error) => {
        if ((error as Error)?.name === "AbortError") return;
      })
      .finally(() => {
        if (!controller.signal.aborted && !cancelled) setOverviewStatsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [chId]);

  useEffect(() => {
    const moveId = Number(new URLSearchParams(window.location.search).get("growthMove"));
    if (!Number.isSafeInteger(moveId) || moveId <= 0) return;
    const controller = new AbortController();
    void fetch(`/api/growth/moves/${moveId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as {
          move?: { reason?: string; missingSlots?: number | null };
        } | null;
        if (!response.ok || !body?.move) return;
        const missing = body.move.missingSlots;
        setGrowthNotice(
          missing
            ? `Развитие: не хватает ${missing} постов. Собери план и одобри слоты.`
            : (body.move.reason ?? "Развитие: закрой дыру в ритме через план на неделю."),
        );
      })
      .catch((error) => {
        if ((error as Error)?.name === "AbortError") return;
      });
    return () => controller.abort();
  }, []);

  const building = data?.buildAttempt?.status === "building";
  useEffect(() => {
    if (!building) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      await load();
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [building, load]);

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Read this at the moment of the user action. A useState initializer runs during the
      // server render first, where `window` is unavailable, and would permanently turn a
      // valid Growth deep link into null after hydration.
      const growthMoveValue = Number(new URLSearchParams(window.location.search).get("growthMove"));
      const growthMoveId = Number.isSafeInteger(growthMoveValue) && growthMoveValue > 0
        ? growthMoveValue
        : null;
      const r = await fetch("/api/autopilot/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: chId,
          generationEngine,
          planningWeeks,
          quickSettings,
          growthMoveId,
        }),
      });
      const d = (await r.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        publicationTargetCount?: number;
        candidateCount?: number;
      } | null;
      if (d?.ok) {
        const publicationCount = Number(d.publicationTargetCount) ||
          plannedPostCountForWeeks(data?.settings?.post_frequency ?? 5, planningWeeks);
        const candidateCount = Number(d.candidateCount) || autopilotCandidateCount(publicationCount);
        const duration = fmtBuildEstimate(estimateAutopilotBuildMinutes(candidateCount));
        s.toast({
          kind: "info",
          title: `Собираю ${publicationCount} ${plural(publicationCount, "пост", "поста", "постов")}`,
          body: `Готовый план появится целиком. Обычно это занимает ${duration}; можно продолжать работу в других разделах.`,
        });
        await load();
      } else {
        const why: Record<string, string> = {
          no_channel: "Сначала подключи Telegram-канал.",
          no_brief: "Сначала настрой автопилот — без этого он не знает, о чём твой канал.",
          worker_unavailable: "Фоновый обработчик не запущен. Перезапусти приложение и повтори.",
          queue_unavailable: "Очередь генерации сейчас недоступна. Попробуй ещё раз через минуту.",
          bad_engine: "Выбери доступную модель и повтори.",
          bad_horizon: "Выбери период от 1 до 12 недель.",
          engine_unavailable: "Для выбранной модели не настроен API-ключ Navy.",
        };
        s.toast({
          kind: "danger",
          title: "Не вышло",
          body: why[d?.error ?? ""] ?? "Что-то пошло не так, попробуй ещё раз.",
        });
        await load();
      }
    } catch {
      s.toast({
        kind: "danger",
        title: "Не удалось запустить сборку",
        body: "Проверь подключение и попробуй ещё раз. Текущий план не изменён.",
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const toggleAutopilot = async () => {
    if (busy || autopilotToggleBusy || !data?.settings || !chId) return;
    const enabled = !data.settings.enabled;
    setAutopilotToggleBusy(true);
    try {
      const response = await fetch("/api/autopilot/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: chId, enabled }),
      });
      const result = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (response.ok && result?.ok) {
        s.toast({
          kind: enabled ? "success" : "info",
          title: enabled ? "Автопилот возобновлён" : "Автопилот приостановлен",
          body: enabled
            ? "Аврора снова будет готовить новые планы по расписанию."
            : "Уже запланированные публикации остаются в календаре.",
        });
      } else {
        s.toast({
          kind: "danger",
          title: enabled ? "Не удалось возобновить Автопилот" : "Не удалось приостановить Автопилот",
          body: result?.error === "access_denied"
            ? "У вас нет права менять режим публикации."
            : "Проверьте подключение и повторите.",
        });
      }
      await load();
    } catch {
      s.toast({
        kind: "danger",
        title: enabled ? "Не удалось возобновить Автопилот" : "Не удалось приостановить Автопилот",
        body: "Проверьте подключение и повторите.",
      });
    } finally {
      setAutopilotToggleBusy(false);
    }
  };

  const cancelBuild = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/autopilot/generate", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: chId }),
      });
      const result = (await response.json().catch(() => null)) as
        | { ok?: boolean; cancelled?: boolean }
        | null;
      if (response.ok && result?.ok) {
        s.toast({
          kind: "info",
          title: result.cancelled ? "Сборка остановлена" : "Сборка уже завершилась",
          body: result.cancelled
            ? "Готовые публикации не затронуты. Можно выбрать другой период и запустить снова."
            : "Обновляю актуальное состояние плана.",
        });
      } else {
        s.toast({
          kind: "danger",
          title: "Не удалось остановить сборку",
          body: "Обнови страницу и повтори. Готовые публикации не затронуты.",
        });
      }
      await load();
    } catch {
      s.toast({
        kind: "danger",
        title: "Не удалось остановить сборку",
        body: "Проверь подключение и повтори. Готовые публикации не затронуты.",
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const continueBuild = async () => {
    const attempt = data?.buildAttempt;
    if (busy || !attempt || attempt.status === "building" || !chId) return;
    setBusy(true);
    try {
      const response = await fetch("/api/autopilot/repair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          planId: attempt.planId,
          revision: attempt.revision,
          channelId: chId,
          jobId: crypto.randomUUID(),
          itemIndexes: attempt.retryableItemIndexes,
        }),
      });
      const result = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (response.ok && result?.ok) {
        s.toast({
          kind: "info",
          title: "Продолжаю сборку",
          body: "Готовые посты сохранены. Аврора работает только с недостающими.",
        });
      } else {
        const why: Record<string, string> = {
          revision_conflict: "План уже изменился. Обновляю его состояние.",
          repair_in_progress: "Сборка уже продолжается в фоне.",
          nothing_to_repair: "Недостающих постов больше нет. Обновляю план.",
          worker_unavailable: "Фоновый обработчик сейчас недоступен. Попробуй позже.",
          queue_unavailable: "Очередь генерации сейчас недоступна. Попробуй позже.",
        };
        s.toast({
          kind: result?.error === "repair_in_progress" ? "info" : "danger",
          title: result?.error === "repair_in_progress" ? "Сборка уже идёт" : "Не удалось продолжить сборку",
          body: why[result?.error ?? ""] ?? "Проверь подключение и повтори. Готовые посты сохранены.",
        });
      }
      await load();
    } catch {
      s.toast({
        kind: "danger",
        title: "Не удалось продолжить сборку",
        body: "Проверь подключение и повтори. Готовые посты сохранены.",
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const approveAll = async () => {
    if (approvalBusy.current) return;
    approvalBusy.current = true;
    setBusy(true);
    try {
      const previewResponse = await fetch("/api/autopilot/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: chId, action: "preview" }),
      });
      const previewBody = (await previewResponse.json().catch(() => null)) as
        | { ok?: boolean; preview?: AutopilotApprovalPreview | null; error?: string }
        | null;
      if (!previewBody?.ok || !previewBody.preview) {
        s.toast({
          kind: previewBody?.ok ? "info" : "danger",
          title: previewBody?.ok ? "План уже обработан" : "Не удалось проверить план",
          body: previewBody?.ok
            ? "Обновил состояние — повторная постановка не нужна."
            : "Ничего не поставлено в очередь. Попробуй ещё раз.",
        });
        await load();
        return;
      }

      const preview = previewBody.preview;
      if (!preview.token) {
        throw new Error("Не получено подтверждение предварительного просмотра");
      }
      const channelName = preview.channel.title ||
        (preview.channel.handle ? `@${preview.channel.handle}` : `канал #${preview.channel.id}`);
      const dateLines = preview.dates.map(
        ({ scheduledAt }) =>
          `• ${new Date(String(scheduledAt)).toLocaleString("ru-RU", {
            timeZone: MSK,
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}`,
      );
      const confirmation = [
        `Канал: ${channelName}`,
        `Будет поставлено в очередь: ${preview.counts.eligible}`,
        ...(dateLines.length ? ["Даты:", ...dateLines] : []),
        ...(preview.counts.expired || preview.counts.blocked
          ? [
              `Не попадут в очередь: ${preview.counts.expired} неактуальных, ${preview.counts.blocked} ещё не готово`,
              "Аврора оставит их вне очереди и заменит при следующем обновлении плана.",
            ]
          : []),
        "",
        "Подтвердить постановку?",
      ].join("\n");
      if (preview.counts.eligible > 0 && !window.confirm(confirmation)) return;

      const previous = approvalAttempt.current;
      const idempotencyKey =
        previous?.planId === preview.planId &&
        previous.revision === preview.revision &&
        previous.hash === preview.hash
          ? previous.key
          : `web-${preview.revision}-${crypto.randomUUID()}`;
      approvalAttempt.current = {
        planId: preview.planId,
        revision: preview.revision,
        hash: preview.hash,
        key: idempotencyKey,
      };
      const confirmationResponse = await fetch("/api/autopilot/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: chId,
          action: "confirm",
          planId: preview.planId,
          idempotencyKey,
          previewToken: preview.token,
          planRevision: preview.revision,
          previewHash: preview.hash,
        }),
      });
      const result = (await confirmationResponse.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            scheduled?: number;
            blocked?: number;
            expired?: number;
            partial?: boolean;
            retryable?: boolean;
            remaining?: { eligible?: number };
            preview?: AutopilotApprovalPreview | null;
          }
        | null;
      // A structured response means the server stored the result for this key. A later
      // retry should use a fresh key and operate only on the remaining plan items.
      approvalAttempt.current = null;
      if (result?.error === "stale_preview") {
        const fresh = result.preview;
        if (fresh) {
          const freshChannel = fresh.channel.title ||
            (fresh.channel.handle ? `@${fresh.channel.handle}` : `канал #${fresh.channel.id}`);
          const freshDates = fresh.dates.map(
            ({ scheduledAt }) => `• ${new Date(String(scheduledAt)).toLocaleString("ru-RU", {
              timeZone: MSK,
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}`,
          );
          window.alert([
            "План изменился после preview. Ничего не поставлено в очередь.",
            "",
            `Канал: ${freshChannel}`,
            `Теперь можно поставить: ${fresh.counts.eligible}`,
            `Неактуально: ${fresh.counts.expired}; ещё не готово: ${fresh.counts.blocked}`,
            ...(freshDates.length ? ["Новые даты:", ...freshDates] : []),
            "",
            "Проверь изменения и нажми «Одобрить всё» ещё раз.",
          ].join("\n"));
        } else {
          s.toast({
            kind: "info",
            title: "План изменился",
            body: "Ничего не поставлено в очередь. План уже обрабатывается или больше не доступен.",
          });
        }
      } else if (result?.ok) {
        const skipped = Number(result.blocked || 0) + Number(result.expired || 0);
        s.toast({
          kind: result.scheduled ? (skipped ? "info" : "success") : "info",
          title: result.scheduled
            ? `Одобрено — ${result.scheduled} в очереди 🚀`
            : "Ничего не поставлено в очередь",
          body: skipped
            ? `${result.expired || 0} неактуальных и ${result.blocked || 0} неготовых материалов не попали в очередь.`
            : "Посты выйдут по показанному расписанию. Компьютер держать включённым не нужно.",
        });
      } else if (result?.error === "scheduling_failed") {
        s.toast({
          kind: "danger",
          title: result.partial
            ? `${result.scheduled || 0} уже в календаре, продолжение остановлено`
            : "Не удалось добавить план в календарь",
          body: result.partial
            ? `Состояние сохранено. Осталось безопасно повторить: ${result.remaining?.eligible || 0}.`
            : "Ни одного нового поста не создано. Обнови план и безопасно повтори.",
        });
      } else {
        s.toast({
          kind: "danger",
          title: "План не одобрен",
          body: "Ничего дополнительно не поставлено в очередь. Обнови план и попробуй ещё раз.",
        });
      }
      await load();
    } catch {
      // Keep the key after an ambiguous network failure: the next click replays the same
      // server-side result instead of risking a duplicate operation.
      s.toast({
        kind: "danger",
        title: "Не удалось получить ответ",
        body: "Не повторяй даты вручную: нажми ещё раз, и я безопасно проверю ту же операцию.",
      });
    } finally {
      approvalBusy.current = false;
      setBusy(false);
    }
  };

  const itemAction = async (index: number, action: string, draft?: string) => {
    const plan = data?.activePlan ?? data?.plan;
    const channelId = data?.channelId;
    if (!plan || !channelId || channelId !== chId) return;
    const identity = `${channelId}:${plan.id}:${plan.revision}`;
    const r = await fetch("/api/autopilot/item", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        index,
        action,
        draft,
        channelId,
        planId: plan.id,
        planRevision: plan.revision,
        itemId: index,
        idempotencyKey: action === "approve" ? `item-${crypto.randomUUID()}` : undefined,
      }),
    }).catch(() => null);
    const result = (await r?.json().catch(() => null)) as
      | {
          ok?: boolean;
          error?: string;
          blockers?: string[];
          reconciliationPending?: boolean;
          scheduledAt?: string;
        }
      | null;
    if (activePlanIdentity.current !== identity) return;
    if (result?.error === "approval_blocked") {
      s.toast({
        kind: "danger",
        title: "Пост нельзя поставить в очередь",
        body: result.blockers?.[0] ?? "Выбери новую дату, исправь замечания или пересобери план.",
      });
    } else if (result?.error === "scheduling_failed") {
      s.toast({
        kind: "danger",
        title: "Не удалось добавить пост в календарь",
        body: "Пост не создан. Обнови план и безопасно повтори.",
      });
    } else if (result?.error === "stale_plan") {
      s.toast({
        kind: "info",
        title: "План уже изменился",
        body: "Обновил карточки. Повтори действие для актуальной версии плана.",
      });
    } else if (result?.ok && action === "approve") {
      s.toast({
        kind: "success",
        title: "Пост добавлен в календарь",
        body: result.reconciliationPending
          ? "Дата сохранена. Отправку в очередь Аврора повторит автоматически."
          : "Он выйдет в запланированное время.",
      });
    }
    await load();
  };

  const openEditor = async (item: PlanItem) => {
    const plan = data?.activePlan ?? data?.plan;
    const channelId = data?.channelId;
    if (!plan || !channelId || channelId !== chId || editorBusyIndex != null) return;
    setEditorBusyIndex(item.i);
    try {
      const response = await fetch("/api/autopilot/item/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId,
          planId: plan.id,
          planRevision: plan.revision,
          index: item.i,
        }),
      });
      const result = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; draftId?: number }
        | null;
      if (response.ok && result?.ok && Number.isSafeInteger(result.draftId)) {
        const params = new URLSearchParams({
          draft: String(result.draftId),
          channel: String(channelId),
          from: "autopilot",
        });
        router.push(`/app/composer?${params.toString()}`);
        return;
      }
      const copy: Record<string, string> = {
        stale_plan: "План уже изменился. Обновляю карточки — открой редактор ещё раз.",
        item_unavailable: "Этот пост уже обработан и больше не доступен для правки.",
        empty_draft: "В этом посте пока нет текста для редактора.",
      };
      s.toast({
        kind: "danger",
        title: "Не удалось открыть редактор",
        body: copy[result?.error ?? ""] ?? "Проверь подключение и повтори.",
      });
      await load();
    } catch {
      s.toast({
        kind: "danger",
        title: "Не удалось открыть редактор",
        body: "Проверь подключение и повтори.",
      });
    } finally {
      setEditorBusyIndex(null);
    }
  };

  if (loading) {
    return (
      <AppShell title="Автопилот" subtitle="Аврора создаёт контент, публикует и анализирует результаты.">
        <div className="space-y-5" role="status" aria-label="Загружается обзор Автопилота">
          <div className="skeleton h-[14.75rem] rounded-lg" />
          <div className="grid gap-3 md:grid-cols-3">
            <div className="skeleton h-28 rounded-lg" />
            <div className="skeleton h-28 rounded-lg" />
            <div className="skeleton h-28 rounded-lg" />
          </div>
          <div className="skeleton h-56 rounded-lg" />
        </div>
      </AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell title="Автопилот" subtitle="Аврора создаёт контент, публикует и анализирует результаты.">
        <Card className="p-8 text-center" role="alert">
          <AlertTriangle className="mx-auto h-7 w-7 text-brand" aria-hidden />
          <p className="mt-3 text-[15px] font-semibold text-text">Не удалось загрузить Автопилот</p>
          <p className="mx-auto mt-1 max-w-md text-[14px] leading-relaxed text-text-3">
            {loadError ?? "Проверь подключение и повтори."}
          </p>
          <div className="mt-4">
            <Button variant="brand" onClick={() => void load()}>
              Повторить загрузку
            </Button>
          </div>
        </Card>
      </AppShell>
    );
  }

  // Спрашиваем СЕРВЕР, а не стор: каналы в сторе приезжают отдельным запросом, и на его
  // фоне «Сначала подключи канал» мигало бы человеку, у которого канал давно подключён.
  if (!data.hasChannel) {
    return (
      <AppShell title="Автопилот" subtitle="Аврора создаёт контент, публикует и анализирует результаты.">
        <Card className="py-4">
          <EmptyState
            icon={<Rocket className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title="Сначала подключи канал"
            body="Автопилот публикует в твой Telegram-канал. Подключи его — и я соберу контент-план."
            action={
              <Link href="/app/onboarding" className={buttonClassName({ variant: "solid" })}>
                Подключить канал
              </Link>
            }
          />
        </Card>
      </AppShell>
    );
  }

  const picker = (
    <ChannelPicker
      channels={tgChannels}
      value={chId}
      onChange={setPicked}
      label="Какой канал ведём"
      className="mb-5"
    />
  );

  // Пока автопилот не знает, о чём канал, он писал наугад. Не пускаем дальше настройки.
  // Бриф свой у каждого канала: подключил второй — здесь же его и настроишь.
  if (!data.briefReady) {
    return (
      <AppShell
        title="Автопилот"
        subtitle="Аврора создаёт контент, публикует и анализирует результаты."
      >
        {picker}
        <Card className="py-4">
          <EmptyState
            icon={<Settings2 className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title="Сначала настрой автопилот"
            body="Чтобы посты были про твоё дело, а не ни о чём, мне нужно знать: о чём канал, для кого и о чём писать нельзя. Займёт минуту — или дай прочитать твой канал, и я предложу всё сам."
            action={
              <Link
                href={`/app/settings${chId ? `?channel=${chId}` : ""}`}
                className={buttonClassName({ variant: "brand" })}
              >
                <Wand2 className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
                Настроить автопилот
              </Link>
            }
          />
        </Card>
      </AppShell>
    );
  }

  const st = data.settings!;
  const plan = data.activePlan ?? data.plan;
  const buildAttempt = data.buildAttempt;
  const planItems = plan?.items ?? [];
  // Legacy plans may contain internal quality-review drafts. The reader-facing product
  // boundary is stricter: show only verified material (plus already published history).
  const items = planItems.filter((item) =>
    item.status !== "expired" && item.status !== "rejected" &&
      (
        item.status === "approved" || item.status === "published" ||
        isAutopilotReaderReadyItem(item)
      ),
  );
  const pending = items.filter((it) => it.status === "pending");
  const editorPending = pending.filter((item) => Boolean(item.draftId));
  const reviewPending = pending.filter(
    (item) => !item.draftId && isAutopilotHumanReviewItem(item),
  );
  const readyPending = pending.filter(
    (item) => !item.draftId && canApproveItem(item) && !isAutopilotHumanReviewItem(item),
  );
  const approved = items.filter((it) => it.status === "approved" || it.status === "published");
  const canOfferFull = st.approvals_streak >= 2 && st.mode !== "full";

  // Отсортированный по времени список для ленты недели и карточек.
  const visible = [...items]
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  const hasUsablePlan = Boolean(plan && visible.length > 0);
  const rangeLabel =
    visible.length > 0
      ? `${fmtRangeMsk(visible[0].scheduledAt)} — ${fmtRangeMsk(visible[visible.length - 1].scheduledAt)}`
      : "";
  const allApproved = pending.length === 0 && approved.length > 0;
  const plannedCount = plannedPostCountForWeeks(st.post_frequency, planningWeeks);
  const missingBuildCount = buildAttempt
    ? Math.max(0, buildAttempt.publicationTargetCount - buildAttempt.readyCount)
    : plannedCount;
  const generationWorkCount = autopilotCandidateCount(plannedCount);
  const plannedDuration = fmtBuildEstimate(estimateAutopilotBuildMinutes(generationWorkCount));
  const renderedVisible = visible.slice(0, visibleLimit);
  const planEndLabel = new Date(planningAnchorMs + planningWeeks * 7 * 86_400_000).toLocaleDateString(
    "ru-RU",
    { day: "numeric", month: "long", year: "numeric" },
  );
  const currentWeekStartKey = mondayDateKey(new Date());
  const currentWeekEndKey = shiftDateKey(currentWeekStartKey, 7);
  const recentAutopilotPosts = s.realPosts
    .filter((post) => (
      post.channel_id === chId &&
      post.publication_origin === "autopilot" &&
      post.status === "published" &&
      Boolean(post.published_at ?? post.scheduled_at)
    ))
    .sort((a, b) => new Date(b.published_at ?? b.scheduled_at ?? b.created_at).getTime() - new Date(a.published_at ?? a.scheduled_at ?? a.created_at).getTime());
  const weeklyPublishedPosts = recentAutopilotPosts.filter((post) => {
    const key = moscowDateKey(post.published_at ?? post.scheduled_at ?? post.created_at);
    return key >= currentWeekStartKey && key < currentWeekEndKey;
  });
  const overviewStatsByPost = new Map((overviewStats?.posts ?? []).map((post) => [post.id, post]));
  const weeklyMeasuredStats = weeklyPublishedPosts
    .map((post) => overviewStatsByPost.get(post.id))
    .filter((post): post is OverviewPostStat => Boolean(post && post.views != null));
  const weeklyViews = weeklyMeasuredStats.reduce((total, post) => total + (post.views ?? 0), 0);
  const weeklyReactions = weeklyMeasuredStats.reduce((total, post) => total + (post.reactions ?? 0), 0);
  const weeklyEngagement = weeklyViews > 0 ? `${Math.round((weeklyReactions / weeklyViews) * 1000) / 10}%` : "—";
  const metricNote = overviewStatsLoading
    ? "Метрики обновляются"
    : weeklyMeasuredStats.length > 0
      ? "за текущую неделю"
      : "Данных за неделю пока нет";
  const scheduleReference = visible.find((item) => (
    moscowDateKey(item.scheduledAt) >= currentWeekStartKey && item.status !== "published"
  ))?.scheduledAt ?? visible[0]?.scheduledAt ?? new Date();
  const scheduleWeekStart = mondayDateKey(scheduleReference);
  const scheduleDays: OverviewScheduleDay[] = Array.from({ length: 7 }, (_, index) => {
    const key = shiftDateKey(scheduleWeekStart, index);
    const date = dateForKey(key);
    return {
      key,
      weekday: new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" }).format(date).replace(".", ""),
      date: date.getUTCDate(),
      items: visible.filter((item) => moscowDateKey(item.scheduledAt) === key),
    };
  });

  return (
    <AppShell
      title="Автопилот"
      subtitle="Аврора создаёт контент, публикует и анализирует результаты."
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/app/settings${chId ? `?channel=${chId}` : ""}`}
            className={buttonClassName({ variant: "outline", size: "md" })}
          >
            <Settings2 className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
            Настройки
          </Link>
          <Button
            type="button"
            variant="brand"
            size="md"
            onClick={generate}
            loading={busy}
            disabled={busy || autopilotToggleBusy || building}
          >
            <Play className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
            {building ? "План собирается" : "Запустить автопилот"}
          </Button>
        </div>
      }
    >
      {picker}
      {growthNotice && (
        <Card className="mb-5 p-4">
          <p className="text-[14px] leading-relaxed text-text">{growthNotice}</p>
        </Card>
      )}

      <AutopilotHero
        enabled={st.enabled}
        building={building}
        hasPlan={hasUsablePlan}
        busy={autopilotToggleBusy}
        blocked={busy}
        onToggle={() => void toggleAutopilot()}
      />

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <OverviewMetricCard
          icon={<Send className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
          label="Опубликовано"
          value={s.realReady ? String(weeklyPublishedPosts.length) : "—"}
          note={s.realReady ? "за текущую неделю" : "Публикации загружаются"}
          tone="brand"
        />
        <OverviewMetricCard
          icon={<Eye className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
          label="Просмотры"
          value={weeklyMeasuredStats.length > 0 ? fmtCompact(weeklyViews) : "—"}
          note={metricNote}
          tone="success"
        />
        <OverviewMetricCard
          icon={<BarChart3 className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
          label="Вовлечённость"
          value={weeklyEngagement}
          note={metricNote}
          tone="violet"
        />
      </div>

      <div className="mt-5">
        <WeekSchedule days={scheduleDays} />
      </div>

      <div className="mt-5">
        <RecentPublications posts={recentAutopilotPosts.slice(0, 3)} loading={!s.realReady} />
      </div>

      <Card as="section" className="mt-5 mb-5 p-4 sm:p-5" aria-labelledby="autopilot-plan-settings-title">
        <div className="mb-4">
          <h2 id="autopilot-plan-settings-title" className="text-[17px] font-extrabold tracking-tight text-text">
            Параметры следующего плана
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-text-3">
            Аврора сохранит правила канала и применит эти параметры к новой сборке.
          </p>
        </div>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 lg:max-w-xs lg:flex-1">
            <label htmlFor="autopilot-horizon" className="text-[13px] font-semibold text-text">
              Период
            </label>
            <select
              id="autopilot-horizon"
              value={planningWeeks}
              onChange={(event) => setPlanningWeeks(Number(event.target.value))}
              disabled={busy || building}
              className="mt-2 h-11 w-full rounded-md border border-line bg-surface px-3 text-base font-semibold text-text outline-none transition-colors focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-60 sm:text-[14px]"
            >
              {Array.from(
                { length: MAX_AUTOPILOT_PLANNING_WEEKS - MIN_AUTOPILOT_PLANNING_WEEKS + 1 },
                (_, index) => index + MIN_AUTOPILOT_PLANNING_WEEKS,
              ).map((weeks) => (
                <option key={weeks} value={weeks}>
                  {weeks} {plural(weeks, "неделя", "недели", "недель")}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-[12px] text-text-3" aria-live="polite">
              До {planEndLabel} · {plannedCount} {plural(plannedCount, "публикация", "публикации", "публикаций")}
              {` · сборка — ${plannedDuration}`}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row lg:shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setQuickSettingsOpen(true)}
              disabled={busy || building}
              aria-haspopup="dialog"
              className="min-h-11"
            >
              <Settings2 className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
              Настроить посты
            </Button>
          </div>
        </div>
        <p className="mt-3 [overflow-wrap:anywhere] text-[12px] leading-relaxed text-text-3">
          {quickSettingsSummary(quickSettings)}
        </p>
      </Card>

      <QuickSettingsDialog
        open={quickSettingsOpen}
        settings={quickSettings}
        disabled={busy || building}
        channelId={chId}
        onChange={setQuickSettings}
        onClose={() => setQuickSettingsOpen(false)}
      />

      {/* Предложение полного режима после 2 недель без правок */}
      {canOfferFull && (
        <div className="mb-5 flex items-start gap-3 rounded-lg bg-info-soft p-4">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
          <div className="flex-1">
            <p className="text-[14px] font-semibold text-text">
              Ты 2 недели одобрял планы без правок — можно доверить полностью
            </p>
            <p className="mt-1 text-[13px] text-text-2">
              В полном режиме посты будут выходить без твоего подтверждения. В любой момент вернёшь.
            </p>
            <div className="mt-3">
              <Link
                href={`/app/settings${chId ? `?channel=${chId}` : ""}`}
                className={buttonClassName({ size: "sm", variant: "brand" })}
              >
                Проверить и включить в настройках
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Состояние новой сборки не заменяет пригодный план. */}
      {buildAttempt && (
        <BuildAttemptPanel
          attempt={buildAttempt}
          busy={busy}
          reducedMotion={reduce}
          onContinue={() => void continueBuild()}
          onCancel={() => void cancelBuild()}
          channelId={chId}
        />
      )}
      {loadError && buildAttempt?.status === "building" && (
        <p className="mb-5 text-[13px] text-danger" role="status">
          Прогресс временно не обновляется. Аврора повторит проверку автоматически.
        </p>
      )}

      {!hasUsablePlan ? (
        <Card className="py-4">
          <EmptyState
            icon={<Newspaper className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title={building
              ? "План собирается"
              : buildAttempt
                ? "План появится здесь целиком"
                : "Готового плана пока нет"}
            body={building
              ? `Аврора подготовит все ${plannedCount} ${plural(plannedCount, "пост", "поста", "постов")} и покажет план целиком.`
              : buildAttempt && buildAttempt.readyCount > 0
                ? `Осталось подготовить ${missingBuildCount} ${plural(missingBuildCount, "пост", "поста", "постов")}. Готовые тексты уже сохранены.`
                : buildAttempt
                  ? `Аврора покажет план, когда все ${buildAttempt.publicationTargetCount} ${plural(buildAttempt.publicationTargetCount, "пост", "поста", "постов")} будут готовы.`
              : "Выбери период и запусти сборку. Аврора сама найдёт темы, напишет и проверит посты."}
          />
        </Card>
      ) : (
        <div className="space-y-5">
          {/* Обзор плана — с одного взгляда: что, когда и что от тебя нужно */}
          <Card className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[15px] font-bold text-text">
                  {allApproved ? "Контент-план в очереди 🚀" : "Контент-план готов"}
                </p>
                <p className="mt-0.5 text-[13px] text-text-3">
                  {visible.length} {plural(visible.length, "пост", "поста", "постов")}
                  {rangeLabel && <> · {rangeLabel}</>}
                  {readyPending.length > 0 && (
                    <>
                      {" "}
                      · {readyPending.length} {plural(readyPending.length, "готов", "готовы", "готовы")} к одобрению
                    </>
                  )}
                  {reviewPending.length > 0 && (
                    <>
                      {" "}
                      · {reviewPending.length} на согласовании
                    </>
                  )}
                  {editorPending.length > 0 && (
                    <>
                      {" "}
                      · {editorPending.length} {plural(editorPending.length, "пост", "поста", "постов")} в редакторе
                    </>
                  )}
                  {plan && visible.length === plannedDailyAutopilotPostCount(plan.planningWeeks || 1) && (
                    <> · по одному посту на каждый день</>
                  )}
                </p>
              </div>
              {readyPending.length > 0 ? (
                <Button variant="brand" onClick={approveAll} loading={busy} disabled={busy}>
                  <Check className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
                  Одобрить всё
                </Button>
              ) : allApproved ? (
                <Link
                  href="/app/calendar"
                  className={buttonClassName({ variant: "soft", size: "sm" })}
                >
                  <CalendarCheck className="h-4 w-4" aria-hidden />
                  Открыть календарь
                </Link>
              ) : null}
            </div>

            {/* Полоса дней. Кликни день — раскроется текст этого поста ниже. */}
            <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
              {renderedVisible.map((it) => {
                const done = it.status === "approved" || it.status === "published";
                const active = expanded === it.i;
                return (
                  <button
                    key={it.i}
                    type="button"
                    onClick={() => setExpanded(active ? null : it.i)}
                    aria-pressed={active}
                    aria-label={`${active ? "Свернуть" : "Открыть"} пост «${it.topic}»`}
                    className={cn(
                      "flex min-w-[84px] flex-1 flex-col items-center gap-1 rounded-lg border px-2 py-3 text-center transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15",
                      active
                        ? "border-brand bg-info-soft"
                        : "border-line bg-surface-inset hover:border-brand/40",
                    )}
                  >
                    <span className="text-[12px] font-semibold capitalize text-text-3">
                      {fmtDayMsk(it.scheduledAt)}
                    </span>
                    <span className="text-[22px] leading-none" aria-hidden>
                      {topicIcon(it.topic, it.rubric)}
                    </span>
                    <span className="nums text-[12px] font-semibold text-text">
                      {fmtTimeMsk(it.scheduledAt)}
                    </span>
                    <span
                      className={cn(
                        "mt-0.5 h-1.5 w-1.5 rounded-full",
                        done
                          ? "bg-success"
                          : "bg-brand",
                      )}
                      aria-hidden
                    />
                  </button>
                );
              })}
            </div>

            {/* Легенда — чтобы точки на полосе читались */}
            <div className="mt-2 flex items-center gap-4 text-[12px] text-text-3">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
                ждёт тебя
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />в очереди
              </span>
            </div>
          </Card>

          {/* Посты плана — компактные карточки, раскрываются по клику */}
          <ul className="space-y-3">
            {renderedVisible.map((it) => {
              const done = it.status === "approved" || it.status === "published";
              const isOpen = expanded === it.i;
              return (
                <motion.li
                  key={it.i}
                  initial={reduce ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <Card className="overflow-hidden p-0">
                    {/* Шапка: иконка темы + тема + когда + статус. Клик — раскрыть/свернуть. */}
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : it.i)}
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? "Свернуть" : "Открыть"} пост «${it.topic}»`}
                      className="flex w-full items-center gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-brand/15"
                    >
                      <span
                        className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-inset text-[20px]"
                        aria-hidden
                      >
                        {topicIcon(it.topic, it.rubric)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold text-text">
                          {it.topic}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[13px] text-text-3">
                          <Clock className="h-3.5 w-3.5" aria-hidden />
                          <span className="nums capitalize">
                            {fmtDayMsk(it.scheduledAt)}, {fmtTimeMsk(it.scheduledAt)}
                          </span>
                        </span>
                      </span>
                      {done ? (
                        <Badge tone="success">
                          <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden />в очереди
                        </Badge>
                      ) : it.draftId ? (
                        <Badge tone="brand">в редакторе</Badge>
                      ) : isAutopilotHumanReviewItem(it) ? (
                        <Badge tone="brand">на согласовании</Badge>
                      ) : (
                        <Badge tone="success">
                          {hasHumanQualityAttestation(it.quality)
                            ? "подтверждено вручную"
                            : "готов к просмотру"}
                        </Badge>
                      )}
                      <ChevronDown
                        className={cn(
                          "h-4 w-4 shrink-0 text-text-3 transition-transform",
                          isOpen && "rotate-180",
                        )}
                        aria-hidden
                      />
                    </button>

                    {/* Тело: готовый читательский текст. Исследовательские источники остаются внутри Авроры. */}
                    <div className="px-4 pb-4">
                      <PostPreview text={it.draft} expanded={isOpen} />

                      {it.draftId && (
                        <div className="mt-3">
                          <EvidenceCard kind="draft" id={it.draftId} compact />
                        </div>
                      )}

                      {isAutopilotHumanReviewItem(it) && (
                        <div className="mt-3 flex items-start gap-2 rounded-sm bg-info-soft p-3">
                          <Sparkles
                            className="mt-0.5 h-4 w-4 shrink-0 text-info-text"
                            aria-hidden
                          />
                          <p className="text-[13px] leading-snug text-info-text">
                            <span className="font-semibold">
                              {it.reviewState === "editorial_review"
                                ? it.quality?.violations?.[0]?.message ?? "Пост требует редакционной проверки."
                                : "Автопроверка фактов требует твоего подтверждения."}
                            </span>{" "}
                            Прочитай текст перед публикацией: без твоего решения он не выйдет автоматически.
                          </p>
                        </div>
                      )}

                      {it.status === "pending" && it.draftId && (
                        <div className="mt-3 flex items-start gap-2 rounded-sm bg-info-soft p-3">
                          <Pencil className="mt-0.5 h-4 w-4 shrink-0 text-info-text" aria-hidden />
                          <p className="text-[13px] leading-snug text-info-text">
                            Правки сохранены в редакторе. Поставь пост в календарь оттуда — дата Автопилота уже выбрана.
                          </p>
                        </div>
                      )}

                      {it.status === "pending" && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {!it.draftId && (
                            <Button
                              size="sm"
                              variant="soft"
                              disabled={!canApproveItem(it)}
                              onClick={() => itemAction(it.i, "approve")}
                            >
                              <Check className="h-4 w-4" aria-hidden />
                              Одобрить
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={editorBusyIndex === it.i}
                            disabled={editorBusyIndex != null}
                            onClick={() => void openEditor(it)}
                          >
                            <Pencil className="h-4 w-4" aria-hidden />
                            Открыть в редакторе
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => itemAction(it.i, "reject")}>
                            <X className="h-4 w-4" aria-hidden />
                            Убрать
                          </Button>
                        </div>
                      )}
                    </div>
                  </Card>
                </motion.li>
              );
            })}
          </ul>
          {visible.length > renderedVisible.length && (
            <div className="flex justify-center pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => setVisibleLimit((current) => Math.min(visible.length, current + 14))}
              >
                Показать ещё {Math.min(14, visible.length - renderedVisible.length)}
              </Button>
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}
