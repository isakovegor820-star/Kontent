"use client";

// А10. Автопилот (ТЗ 5.6, Д.9). ИИ собирает план недели по аналитике (Д.5) и залётам (Д.7),
// в стиле пользователя. Одобрил — посты уходят в ту же очередь публикации (Д.3). Настоящие
// данные, никаких фейков: нет движка/аналитики — честно помечаем.

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  CalendarCheck,
  Check,
  ChevronDown,
  Clock,
  Loader2,
  Newspaper,
  Pencil,
  Rocket,
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
import { cn, plural } from "@/lib/utils";
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

const MSK = "Europe/Moscow";
const fmtDayMsk = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { timeZone: MSK, weekday: "short", day: "numeric" });
const fmtTimeMsk = (iso: string) =>
  new Date(iso).toLocaleTimeString("ru-RU", { timeZone: MSK, hour: "2-digit", minute: "2-digit" });
const fmtRangeMsk = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { timeZone: MSK, day: "numeric", month: "short" });

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
  onGenerate,
  onCancel,
  channelId,
}: {
  attempt: BuildAttempt;
  busy: boolean;
  reducedMotion: boolean | null;
  onGenerate: () => void;
  onCancel: () => void;
  channelId: number | null;
}) {
  const readyCount = Math.min(attempt.readyCount, attempt.publicationTargetCount);
  const remaining = Math.max(0, attempt.publicationTargetCount - readyCount);
  const terminal = attempt.status === "error";
  const title = attempt.status === "building"
    ? `Собираю ${attempt.publicationTargetCount} ${plural(attempt.publicationTargetCount, "пост", "поста", "постов")}`
    : "План пока не готов";
  const description = attempt.status === "building"
    ? remaining > 0
      ? `Готово ${readyCount} из ${attempt.publicationTargetCount}. Неудачные тексты Аврора переписывает сама.`
      : "Тексты готовы. Аврора завершает проверку и раскладывает их по расписанию."
    : attempt.errorReason === "quota"
      ? "Дневной лимит генераций закончился до завершения плана. Запусти сборку после обновления лимита."
      : attempt.errorReason === "cancelled"
        ? "Сборка остановлена. Когда будешь готов, запусти её снова."
        : attempt.primaryFix === "add_knowledge"
          ? "По выбранным темам не хватило подтверждённых материалов. Добавь факты о канале и собери план снова."
          : "Аврора не смогла завершить все посты. Запусти сборку снова — план появится только целиком.";
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
              <Button variant="primary" size="sm" onClick={onGenerate} loading={busy} disabled={busy}>
                Собрать заново
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
      <AppShell title="Автопилот">
        <div className="space-y-4">
          <div className="skeleton h-24 rounded-lg" />
          <div className="skeleton h-64 rounded-lg" />
        </div>
      </AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell title="Автопилот">
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
      <AppShell title="Автопилот" subtitle="Выбери любой период от 1 до 12 недель.">
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
        subtitle="Выбери любой период от 1 до 12 недель."
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
  const rangeLabel =
    visible.length > 0
      ? `${fmtRangeMsk(visible[0].scheduledAt)} — ${fmtRangeMsk(visible[visible.length - 1].scheduledAt)}`
      : "";
  const allApproved = pending.length === 0 && approved.length > 0;
  const plannedCount = plannedPostCountForWeeks(st.post_frequency, planningWeeks);
  const generationWorkCount = autopilotCandidateCount(plannedCount);
  const plannedDuration = fmtBuildEstimate(estimateAutopilotBuildMinutes(generationWorkCount));
  const renderedVisible = visible.slice(0, visibleLimit);
  const planEndLabel = new Date(planningAnchorMs + planningWeeks * 7 * 86_400_000).toLocaleDateString(
    "ru-RU",
    { day: "numeric", month: "long", year: "numeric" },
  );

  return (
    <AppShell
      title="Автопилот"
      subtitle="Аврора сама найдёт свежие инфоповоды, выберет интересные темы и подготовит готовые посты."
    >
      {picker}
      {growthNotice && (
        <Card className="mb-5 p-4">
          <p className="text-[14px] leading-relaxed text-text">{growthNotice}</p>
        </Card>
      )}
      {/* Короткое резюме канала. Редкие ограничения и стратегия остаются в полных настройках. */}
      <Card className="mb-5 p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={st.enabled ? "success" : "neutral"}>
                {st.enabled ? "Автопилот включён" : "Автопилот выключен"}
              </Badge>
              <Badge tone="neutral">
                {st.post_frequency} {plural(st.post_frequency, "публикация", "публикации", "публикаций")} в неделю
              </Badge>
              <Badge tone="neutral">
                {st.mode === "full" ? "без подтверждения" : "с подтверждением"}
              </Badge>
            </div>
            <p className="mt-3 min-w-0 text-[13px] leading-relaxed text-text-3">
              <span className="font-semibold text-text-2">Пишу про: </span>
              {data.brief?.niche}
              {data.brief?.audience && (
                <>
                  <span className="font-semibold text-text-2"> · для кого: </span>
                  {data.brief.audience}
                </>
              )}
            </p>
          </div>
          <Link
            href={`/app/settings${chId ? `?channel=${chId}` : ""}`}
            className={buttonClassName({ variant: "outline", size: "sm", className: "shrink-0" })}
          >
            <Settings2 className="h-4 w-4" aria-hidden />
            Настройки канала
          </Link>
        </div>
      </Card>

      <Card className="mb-5 p-4 sm:p-5">
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
              className="mt-2 h-11 w-full rounded-md border border-line bg-surface px-3 text-[14px] font-semibold text-text outline-none transition-colors focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20 disabled:cursor-not-allowed disabled:opacity-60"
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
            <Button
              variant="brand"
              onClick={generate}
              loading={busy}
              disabled={busy || building}
              className="min-h-11 shrink-0 lg:min-w-[230px]"
            >
              <Sparkles className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
              {building ? "План собирается" : `${plan ? "Обновить" : "Собрать"} ${plannedCount} ${plural(plannedCount, "пост", "поста", "постов")}`}
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
          onGenerate={() => void generate()}
          onCancel={() => void cancelBuild()}
          channelId={chId}
        />
      )}
      {loadError && buildAttempt?.status === "building" && (
        <p className="mb-5 text-[13px] text-danger" role="status">
          Прогресс временно не обновляется. Аврора повторит проверку автоматически.
        </p>
      )}

      {!plan && visible.length === 0 ? (
        <Card className="py-4">
          <EmptyState
            icon={<Newspaper className="h-6 w-6" strokeWidth={1.75} aria-hidden />}
            title={building ? "План собирается" : "Готового плана пока нет"}
            body={building
              ? `Аврора подготовит все ${plannedCount} ${plural(plannedCount, "пост", "поста", "постов")} и покажет план целиком.`
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
