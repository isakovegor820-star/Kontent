"use client";

// А9. ИИ-студия (ТЗ 5.6, Приложение А).
// Диалог + быстрые команды. ИИ помнит стиль пользователя и следует настройкам платформы.
// Главное действие — сгенерировать и отправить в календарь.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowUp,
  CalendarRange,
  Check,
  ChevronDown,
  CircleStop,
  Clapperboard,
  Copy,
  FileText,
  ImageIcon,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  Plus,
  RefreshCw,
  Sparkles,
  Timer,
  Video,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { EvidenceCard } from "@/components/app/evidence-card";
import { Button } from "@/components/ui/button";
import { Card, Textarea } from "@/components/ui/primitives";
import {
  MediaGenerator,
  type MediaGeneration,
  type MediaKind,
} from "@/components/studio/media-generator";
import { PostSettingsMenu } from "@/components/studio/post-settings-menu";
import { requiresBriefConfirmation } from "@/lib/brief-confirmation";
import { type AiCommand } from "@/lib/ai";
import { acknowledgeAiTerminal, AiTerminalAckError } from "@/lib/ai-client-idempotency";
import { aiFailureRecoveryRu, type AiFailureInfo } from "@/lib/ai-client-recovery";
import {
  aiDraftPhaseLabel,
  createAiDraftProjection,
  projectAiDraftEvent,
} from "@/lib/ai-draft-projection";
import type { ConversationTurn } from "@/lib/ai-provider";
import { finalizeAiClientStream, parseAiStreamBuffer, type AiStreamEvent } from "@/lib/ai-stream";
import { getAiUsageMetrics } from "@/lib/ai-usage-sync";
import {
  createDraftClientKey,
  createServerDraft,
  DraftRequestError,
  getServerDraft,
} from "@/lib/draft-client";
import type { ServerDraft } from "@/lib/draft-types";
import { buildLibraryAdaptation } from "@/lib/library";
import {
  legalOpportunityPostSettings,
  legalOpportunityVariantFromClientKey,
  type LegalOpportunityPostVariant,
} from "@/lib/legal-opportunity-post";
import {
  monthlyCampaignStudioPrompt,
  parseMonthlyCampaignDetail,
} from "@/lib/monthly-campaign-client";
import { studioReferenceGenerationIdentity } from "@/lib/studio-reference-generation";
import {
  DEFAULT_POST_SETTINGS,
  buildPostSettingsSummary,
  normalizePostSettings,
  validatePostSettingsConflicts,
  type PostSettings,
} from "@/lib/post-settings";
import { pickStudioCommand } from "@/lib/studio-command";
import {
  isStudioGenerationPlaceholder,
  mergeStudioChatSessions,
  parseStudioChatSession,
  serializeStudioChatSession,
  stopStudioStreamingMessages,
  studioChatStorageKey,
  type StudioChatGeneration,
  type StudioChatMessage,
} from "@/lib/studio-chat-session";
import {
  abortStudioStream,
  beginStudioStream,
  clearStudioStream,
  ownsStudioStream,
  type StudioStreamBox,
} from "@/lib/studio-stream-control";
import { useStore } from "@/lib/store";
import type { RealChannel } from "@/lib/types";
import { cn, uid } from "@/lib/utils";

/* --------------------------------------------------------------- ОСНОВЫ */

type Msg = StudioChatMessage;

/** Что ИИ должен «помнить» для перегенерации ответа */
type Gen = StudioChatGeneration & {
  autoOpenComposer?: boolean;
  resultClientKey?: string;
  audienceQuestionId?: number;
  audienceQuestionVersion?: number;
  audienceQuestionGenerationKey?: string;
  suggestMedia?: boolean;
  monthlyCampaignId?: number;
  monthlyPlanId?: number;
  monthlyItemId?: number;
};
type AskOptions = {
  cmd?: AiCommand;
  input?: string;
  skipBrief?: boolean;
  requestKey?: string;
  autoOpenComposer?: boolean;
  referenceDraftId?: number;
  referenceDraftVersion?: number;
  resultClientKey?: string;
  audienceQuestionId?: number;
  audienceQuestionVersion?: number;
  audienceQuestionGenerationKey?: string;
  monthlyCampaignId?: number;
  monthlyPlanId?: number;
  monthlyItemId?: number;
  /** Source-bound destination survives reload before the global channel store is ready. */
  channelId?: number | null;
  postSettings?: PostSettings;
  suggestMedia?: boolean;
};
type PendingBrief = { text: string; opts?: Omit<AskOptions, "skipBrief"> };
type PendingLibraryReference = { text: string; source?: string; topic?: string };
type PendingReferenceGeneration = {
  draftId: number;
  version: number;
  prompt: string;
  requestKey: string;
  resultClientKey: string;
  channelId: number;
  network: RealChannel["network"];
  variant?: LegalOpportunityPostVariant;
  suggestMedia?: boolean;
};
type PendingAudienceQuestionGeneration = {
  questionId: number;
  questionVersion: number;
  prompt: string;
  requestKey: string;
  resultClientKey: string;
};
type MonthlyCampaignStudioContext = {
  campaignId: number;
  planId: number;
  itemId: number;
};

type WorkspaceMode = "chat" | "studio";
type ChatPersistenceStatus = "loading" | "saving" | "saved" | "local";

const EASE_SOFT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const ICON = "h-4 w-4";

type Quick = {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** подставить заготовку в поле — человек дописывает тему сам */
  draft?: string;
  /** выполнить сразу, дописывать нечего */
  instant?: string;
  /** открыть настоящий генератор медиа, а не текстовый промпт */
  mediaKind?: MediaKind;
};

const QUICK: Quick[] = [
  {
    id: "write",
    label: "Пост на тему…",
    icon: <Sparkles className={ICON} strokeWidth={2} aria-hidden />,
    draft: "Напиши пост на тему: ",
  },
  {
    id: "plan",
    label: "План на неделю",
    icon: <CalendarRange className={ICON} strokeWidth={2} aria-hidden />,
    instant: "Собери план на неделю",
  },
  {
    id: "script",
    label: "Сценарий видео",
    icon: <Clapperboard className={ICON} strokeWidth={2} aria-hidden />,
    draft: "Придумай сценарий видео про ",
  },
  {
    id: "poll",
    label: "Опрос",
    icon: <ListChecks className={ICON} strokeWidth={2} aria-hidden />,
    draft: "Придумай опрос на тему: ",
  },
  {
    id: "longread",
    label: "Лонгрид",
    icon: <FileText className={ICON} strokeWidth={2} aria-hidden />,
    draft: "Напиши лонгрид про ",
  },
  {
    id: "image",
    label: "Картинка",
    icon: <ImageIcon className={ICON} strokeWidth={2} aria-hidden />,
    mediaKind: "image",
  },
  {
    id: "video",
    label: "Создать рилс",
    icon: <Video className={ICON} strokeWidth={2} aria-hidden />,
    mediaKind: "video",
  },
  {
    id: "rewrite-last",
    label: "Перепиши последнее",
    icon: <RefreshCw className={ICON} strokeWidth={2} aria-hidden />,
  },
];

/** Короткая команда после готового ответа означает редактуру, а не новую тему поста. */
function looksLikeEditFollowUp(text: string): boolean {
  return /^(сделай|исправь|убери|добавь|замени|оставь|измени|поменяй|перестрой|давай|без|больше|меньше|ещё|слишком)\b/i.test(
    text.trim(),
  );
}

function primaryPublication(text: string): string {
  return text.split(/\n\s*---\s*\n/u)[0].trim();
}

function lexicalSimilarity(left: string, right: string): number {
  const words = (value: string) => new Set(value.toLocaleLowerCase("ru").match(/[\p{L}\p{N}]{4,}/gu) ?? []);
  const a = words(left);
  const b = words(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

// Примеры для пустого диалога: показать, что тут вообще можно попросить, вместо голого поля.
// Нейтральные по нише — конкретика приедет из настроек и разведки, выдумывать её не надо.
/* ------------------------------------------------------------- СООБЩЕНИЕ */

function formatGenerationTime(elapsedSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(elapsedSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function GenerationStatus({
  progressLabel,
  onStop,
}: {
  progressLabel?: string;
  onStop: () => void;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const updateElapsed = () => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    };

    updateElapsed();
    const timerId = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timerId);
  }, []);

  const formattedTime = formatGenerationTime(elapsedSeconds);

  return (
    <div className="mt-3 max-w-[72ch] rounded-md border border-brand/25 bg-info-soft p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-gradient text-white shadow-glow"
          aria-hidden
        >
          <LoaderCircle className="h-5 w-5 motion-safe:animate-spin" strokeWidth={2} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-[14px] leading-snug font-bold text-text">Генерация идёт</p>
            <span className="inline-flex items-center gap-1.5 text-[11px] leading-none font-semibold text-info-text">
              <Timer className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              <span>Прошло</span>
              <time className="tabular-nums" dateTime={`PT${elapsedSeconds}S`} aria-label={`Прошло времени: ${formattedTime}`}>
                {formattedTime}
              </time>
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed font-medium text-info-text">
            {progressLabel ?? "Аврора создаёт материал…"}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-col items-stretch justify-between gap-3 border-t border-brand/15 pt-3 sm:flex-row sm:items-center">
        <p className="text-[11px] leading-relaxed text-text-3">
          Готовые фрагменты появляются в ответе сразу.
        </p>
        <Button
          type="button"
          variant="danger"
          size="sm"
          className="w-full border border-danger-text/20 px-4 shadow-sm sm:w-auto"
          onClick={onStop}
          aria-label="Остановить генерацию"
          title="Остановить генерацию"
        >
          <CircleStop className="h-4 w-4" strokeWidth={2} aria-hidden />
          Остановить
        </Button>
      </div>
    </div>
  );
}

function MessageRow({
  msg,
  reduce,
  onStop,
  onSchedule,
  onCopy,
  onRegenerate,
  onRetry,
  onImprove,
  onShorten,
  creatingPost,
}: {
  msg: Msg;
  reduce: boolean;
  onStop: () => void;
  onSchedule: () => void;
  onCopy: () => void;
  onRegenerate: () => void;
  onRetry: () => void;
  onImprove: () => void;
  onShorten: () => void;
  creatingPost: boolean;
}) {
  const appear = {
    initial: reduce ? false : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.26, ease: EASE_SOFT },
  };

  // Пользователь — обычный текст справа, без пузыря и фоновой карточки.
  if (msg.role === "user") {
    return (
      <motion.div {...appear} className="ml-auto w-fit max-w-[min(88%,42rem)] shrink-0 text-right">
        <p className="mb-1 text-[11px] font-bold tracking-wide text-text-3 uppercase">Ты</p>
        <p className="text-[15px] leading-[1.65] whitespace-pre-wrap text-text">{msg.text}</p>
      </motion.div>
    );
  }

  const ready = !msg.streaming && msg.text.trim().length > 0;

  // ИИ — обычный читаемый текст без ещё одной карточки вокруг карточки.
  return (
    <motion.div {...appear} className="w-full shrink-0">
      <div className="min-w-0" aria-busy={msg.streaming || undefined}>
        <p className="mb-2 flex items-center gap-2 text-[11px] font-bold tracking-wide text-text-3 uppercase">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              msg.streaming ? "bg-brand" : "bg-success-text",
            )}
            aria-hidden
          />
          Аврора
        </p>
        {msg.text.trim() && (
          <p className="max-w-[72ch] text-[15px] leading-[1.7] whitespace-pre-wrap text-text">
            {msg.text}
            {msg.streaming && (
              <span
                className="ml-1 inline-block h-[1em] w-0.5 translate-y-[0.12em] rounded-full bg-brand-gradient motion-safe:animate-pulse"
                aria-hidden
              />
            )}
          </p>
        )}

        {msg.streaming && <GenerationStatus progressLabel={msg.progressLabel} onStop={onStop} />}

        {msg.errorMessage && (
          <div role="alert" className="mt-3 max-w-[72ch] rounded-sm border border-danger-text/25 bg-danger-soft px-3 py-2 text-[12px] leading-relaxed text-danger-text">
            <p>{msg.errorMessage}</p>
          </div>
        )}

        {msg.statusMessage && (
          <p
            className="mt-3 max-w-[72ch] rounded-sm border border-line bg-surface-inset px-3 py-2 text-[12px] leading-relaxed text-text-2"
          >
            {msg.statusMessage}
          </p>
        )}

        {!msg.streaming && msg.fallbackUsed && msg.requestedEngine && msg.effectiveEngine && (
          <p className="mt-2 max-w-[72ch] rounded-sm bg-info-soft px-3 py-2 text-[11px] text-info-text">
            Запрошенная модель: {msg.requestedEngine}. Итоговый проход: {msg.effectiveEngine}.
            В ходе генерации использовался резервный маршрут; выбор в настройках не менялся.
          </p>
        )}

        {!msg.streaming && msg.retryable && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button variant="soft" size="sm" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Повторить запрос
            </Button>
            {msg.text.trim() && (
              <Button variant="ghost" size="sm" onClick={onCopy}>
                <Copy className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                Скопировать черновик
              </Button>
            )}
          </div>
        )}

        {/* Complete result remains reviewable even when semantic publication is blocked. */}
        {ready && msg.reviewable && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button
              variant="soft"
              size="sm"
              className="h-8 px-2.5 text-[12px]"
              onClick={onSchedule}
              loading={creatingPost}
            >
              {!creatingPost && <FileText className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />}
              В пост
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2.5 text-[12px]" onClick={onCopy}>
              <Copy className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Скопировать
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2.5 text-[12px]" onClick={onRegenerate}>
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Ещё вариант
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2.5 text-[12px]" onClick={onImprove}>
              <Sparkles className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Улучшить
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2.5 text-[12px]" onClick={onShorten}>
              Короче
            </Button>
          </div>
        )}

      </div>
    </motion.div>
  );
}

/* ----------------------------------------------------------- СКЕЛЕТОНЫ */

function StudioSkeleton() {
  return (
    <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
      <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-line bg-surface-2 shadow-soft">
        <div className="flex h-[clamp(340px,58dvh,560px)] flex-col gap-5 p-4 md:p-5">
          <div className="flex gap-3">
            <div className="skeleton h-7 w-7 shrink-0" />
            <div className="skeleton h-20 w-3/4" />
          </div>
          <div className="skeleton ml-auto h-12 w-2/5" />
          <div className="flex gap-3">
            <div className="skeleton h-7 w-7 shrink-0" />
            <div className="skeleton h-28 w-4/5" />
          </div>
        </div>
        <div className="min-w-0 overflow-hidden border-t border-line p-4 md:p-5">
          <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton h-11 min-w-0 w-full" />
            ))}
          </div>
          <div className="skeleton mt-3 h-[86px] w-full" />
        </div>
      </div>

      <aside className="hidden w-[300px] shrink-0 xl:block">
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} className="flex flex-col gap-3 p-4">
              <div className="skeleton h-5 w-36" />
              <div className="skeleton h-16 w-full" />
              <div className="skeleton h-10 w-full" />
            </Card>
          ))}
        </div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------ ДВИЖОК ИИ */
// Выбор модели-агента. Облачные движки ждут свой ключ, а roadmap-адаптеры отключены.
// Если выбран движок без ключа, генерация честно откажет (см. /api/ai/generate) — тайком
// подменять модель мы не станем, иначе «выбор модели» превращается в декорацию.

interface EngineInfo {
  id: string;
  label: string;
  vendor: string;
  note: string;
  needs: string | null;
  ruFriendly: boolean;
  supported: boolean;
  recommended: boolean;
  status: "ready" | "no_key" | "offline";
  reason: string | null;
}

const engineDot = (st: EngineInfo["status"]) =>
  st === "ready" ? "bg-success-text" : st === "no_key" ? "bg-text-3/40" : "bg-danger-text";

/** Общая обёртка для выпадашек панели: клик вне и Esc закрывают (правило escape-routes). */
function Popover({
  open,
  onClose,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      className={cn(
        // Открываем вверх — панель прижата к низу экрана. Высоту ограничиваем вьюпортом:
        // без этого длинный список уезжал за верхний край и обрезался.
        "fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-40 w-auto",
        "sm:absolute sm:inset-x-auto sm:bottom-[calc(100%+8px)] sm:left-0 sm:w-[320px] sm:max-w-[calc(100vw-2rem)]",
        "max-h-[min(60dvh,420px)] overflow-y-auto overscroll-contain",
        "rounded-md border border-line-strong bg-surface-2 p-2 shadow-lift",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Явное «Создать» объясняет действие без необходимости угадывать смысл иконки плюса. */
function QuickActionsMenu({
  items,
  onPick,
  disabled,
}: {
  items: Quick[];
  onPick: (item: Quick) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Выбрать, что создать"
        className={cn(
          "inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-text-2",
          "transition-colors duration-200 hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-45",
          open && "bg-surface-2 text-text",
        )}
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
        <span className="text-[12px] font-semibold">Создать</span>
      </button>

      <Popover open={open} onClose={() => setOpen(false)} className="p-2.5 sm:w-[300px]">
        <p className="px-2 pb-2 text-[11px] font-bold tracking-wide text-text-3 uppercase">
          Что создать
        </p>
        <div className="grid gap-1">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onPick(item);
                setOpen(false);
              }}
              className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-sm px-3 text-left text-[13px] font-semibold text-text transition-colors hover:bg-surface-inset"
            >
              <span className="shrink-0 text-text-2">
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      </Popover>
    </div>
  );
}

function channelName(channel: RealChannel | undefined): string {
  return channel?.title || channel?.handle || (channel ? `Канал ${channel.id}` : "Нет канала");
}

/** Канал выбирается прямо у поля: профиль одного бренда никогда не смешивается с другим. */
function ChannelMenu({
  channels,
  value,
  onChange,
  disabled,
}: {
  channels: RealChannel[];
  value: number | null;
  onChange: (channelId: number) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = channels.find((channel) => channel.id === value);
  const label = channelName(active);

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        disabled={disabled || channels.length === 0}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={`Канал: ${label}`}
        className={cn(
          "inline-flex min-h-11 max-w-[180px] min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-full px-2.5",
          "text-[12px] font-semibold text-text-2 transition-colors duration-200 hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 motion-reduce:transition-none",
          "disabled:pointer-events-none disabled:opacity-45",
          open && "bg-surface-2 text-text",
        )}
      >
        <MessageSquareText className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
        <span className="truncate">{label}</span>
      </button>

      <Popover open={open} onClose={() => setOpen(false)} className="p-3 sm:w-[320px]">
        <div className="px-1 pb-2">
          <p className="text-[14px] font-extrabold text-text">Для какого канала пишем?</p>
          <p className="mt-1 text-[11px] leading-relaxed text-text-3">
            Аврора возьмёт паспорт и примеры только этого канала.
          </p>
        </div>
        <div className="mt-1 grid gap-1">
          {channels.map((channel) => {
            const selected = channel.id === value;
            return (
              <button
                key={channel.id}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onChange(channel.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-left transition-colors",
                  selected ? "bg-info-soft" : "hover:bg-surface-inset",
                )}
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-inset text-[11px] font-black uppercase text-text-2">
                  {channel.network}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-bold text-text">
                    {channelName(channel)}
                  </span>
                  {channel.handle && channel.title && (
                    <span className="mt-0.5 block truncate text-[10px] text-text-3">{channel.handle}</span>
                  )}
                </span>
                {selected && <Check className="h-4 w-4 shrink-0 text-text" strokeWidth={2.5} aria-hidden />}
              </button>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}

/** Выбор модели как в Codex: в панели видно текущее название, один клик применяет новую. */
function ModelMenu({
  engines,
  current,
  onPick,
  loading,
  disabled,
}: {
  engines: EngineInfo[];
  current: string | null;
  onPick: (engine: EngineInfo) => Promise<void>;
  loading: boolean;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const activeEngine = engines.find((engine) => engine.id === current);
  const label = loading ? "Модель…" : activeEngine?.label ?? "Выбрать модель";

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        disabled={disabled || loading}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Модель: ${label}`}
        className={cn(
          "inline-flex min-h-11 max-w-[180px] min-w-0 shrink cursor-pointer items-center gap-1 rounded-full px-2.5",
          "text-[12px] font-semibold text-text-2 transition-colors duration-200 hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 motion-reduce:transition-none",
          "disabled:pointer-events-none disabled:opacity-45",
          open && "bg-surface-2 text-text",
        )}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} className="p-2.5 sm:w-[300px]">
        <div className="px-2 pb-2">
          <p className="text-[13px] font-extrabold text-text">Выбрать модель</p>
          <p className="mt-0.5 text-[11px] text-text-3">Нажми на название — модель применится сразу.</p>
        </div>

        <div className="grid gap-1">
          {engines.map((engine) => {
            const ready = engine.supported && engine.status === "ready";
            const selected = engine.id === current;
            return (
                <button
                  key={engine.id}
                  type="button"
                  disabled={!ready}
                  aria-pressed={selected}
                  onClick={() => {
                    setOpen(false);
                    void onPick(engine);
                  }}
                  className={cn(
                    "flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-sm px-3 text-left transition-colors",
                    selected ? "bg-info-soft" : "hover:bg-surface-inset",
                    !ready && "cursor-not-allowed opacity-45",
                  )}
                >
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", engineDot(engine.status))} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text">{engine.label}</span>
                  {selected ? (
                    <Check className="h-4 w-4 shrink-0 text-text" strokeWidth={2.5} aria-hidden />
                  ) : !ready ? (
                    <span className="shrink-0 text-[10px] text-text-3">
                      {engine.status === "offline" ? "Ошибка" : "Не подключена"}
                    </span>
                  ) : null}
                </button>
            );
          })}
        </div>

      </Popover>
    </div>
  );
}

/* --------------------------------------------------------------- ЭКРАН */

function StudioPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedWorkspaceMode: WorkspaceMode | null =
    searchParams.get("mode") === "media"
      ? "studio"
      : searchParams.get("mode") === "chat"
        ? "chat"
        : null;
  const s = useStore();
  const showToast = s.toast;
  const reduce = useReducedMotion() ?? false;

  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("chat");
  const [chatSessionOwner, setChatSessionOwner] = useState<number | null>(null);
  const [chatPersistenceStatus, setChatPersistenceStatus] = useState<ChatPersistenceStatus>("loading");
  const [mediaKind, setMediaKind] = useState<MediaKind>("image");
  const [pickedChannelId, setPickedChannelId] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const value = Number(new URLSearchParams(window.location.search).get("channel"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  });
  // Нормализованные параметры публикации нужны генератору и проверке результата.
  // Пользовательский голос и формат редактируются только в единой настройке Авроры.
  const [postSettings, setPostSettings] = useState<PostSettings>(() => normalizePostSettings(DEFAULT_POST_SETTINGS));
  const [creatingPostId, setCreatingPostId] = useState<string | null>(null);
  const [pendingBrief, setPendingBrief] = useState<PendingBrief | null>(null);
  const [pendingLibraryReference, setPendingLibraryReference] = useState<PendingLibraryReference | null>(null);
  const [contextDraft, setContextDraft] = useState<ServerDraft | null>(null);
  const [pendingReferenceGeneration, setPendingReferenceGeneration] = useState<PendingReferenceGeneration | null>(null);
  const [pendingAudienceQuestionGeneration, setPendingAudienceQuestionGeneration] = useState<PendingAudienceQuestionGeneration | null>(null);
  const [postSettingsReady, setPostSettingsReady] = useState(false);
  const [postSettingsSaving, setPostSettingsSaving] = useState(false);
  const [pendingEngineSuggestion, setPendingEngineSuggestion] = useState<EngineInfo | null>(null);

  // Вложенные пункты сайдбара переключают режим через URL. Синхронизируем состояние
  // без перезагрузки страницы, чтобы история чата и настройки медиа не терялись.
  useEffect(() => {
    if (!requestedWorkspaceMode) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URL является внешним источником состояния навигации
    setWorkspaceMode((current) => current === requestedWorkspaceMode ? current : requestedWorkspaceMode);
  }, [requestedWorkspaceMode]);

  const feedRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Стабильная коробка под отмену печати — переживает ререндеры, чистится при уходе с экрана */
  const streamRef = useRef<StudioStreamBox>({ current: null });
  /** Чем был рождён каждый ответ ИИ — чтобы «Ещё вариант» знал, что перегенерировать */
  const genRef = useRef(new Map<string, Gen>());
  /** Один серверный черновик на один клик/ответ, включая безопасный повтор после обрыва сети. */
  const postDraftRef = useRef<{ promise: Promise<void> | null; keys: Map<string, string> }>({
    promise: null,
    keys: new Map(),
  });
  const startedReferenceDraftsRef = useRef<Set<number>>(new Set());
  const startedAudienceQuestionsRef = useRef<Set<string>>(new Set());
  const loadedMonthlyItemsRef = useRef<Set<number>>(new Set());
  const monthlyCampaignContextRef = useRef<MonthlyCampaignStudioContext | null>(null);
  const growthMoveIdRef = useRef<number | null>(null);
  const sessionRevisionRef = useRef(0);
  const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const sessionPersistenceOwnerRef = useRef<number | null>(null);
  const latestSessionSnapshotRef = useRef<{ owner: number; serialized: string } | null>(null);

  const parsedSessionOwner = Number(s.user?.id);
  const sessionOwner = Number.isSafeInteger(parsedSessionOwner) && parsedSessionOwner > 0
    ? parsedSessionOwner
    : null;

  // A request started by one account must not keep running after logout/account switch.
  // The owner-token guard below also prevents any late completion from touching the next chat.
  useEffect(() => {
    if (chatSessionOwner !== null && chatSessionOwner !== sessionOwner) {
      abortStudioStream(streamRef.current);
    }
  }, [chatSessionOwner, sessionOwner]);

  // История диалога относится к аккаунту и хранится на сервере. localStorage — аварийная
  // копия, а старый sessionStorage читаем один раз для бесшовной миграции уже созданных чатов.
  useEffect(() => {
    if (!s.authReady || !sessionOwner || chatSessionOwner === sessionOwner) return;
    let cancelled = false;
    sessionPersistenceOwnerRef.current = sessionOwner;
    sessionRevisionRef.current = 0;
    if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- начало асинхронного восстановления нового аккаунта
    setChatPersistenceStatus("loading");

    void (async () => {
      let serverUnavailable = false;
      let remoteSession = null;
      let revision = 0;
      try {
        const response = await fetch("/api/studio/session", { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as {
          session?: unknown;
          revision?: number;
        } | null;
        if (!response.ok) throw new Error("session_load_failed");
        remoteSession = body?.session
          ? parseStudioChatSession(JSON.stringify(body.session), sessionOwner)
          : null;
        revision = Number.isSafeInteger(body?.revision) ? Number(body?.revision) : 0;
      } catch {
        serverUnavailable = true;
      }

      let localSession = null;
      try {
        const key = studioChatStorageKey(sessionOwner);
        localSession = parseStudioChatSession(localStorage.getItem(key), sessionOwner)
          ?? parseStudioChatSession(sessionStorage.getItem(key), sessionOwner);
      } catch {
        // В приватном режиме storage может быть запрещён — сервер остаётся источником правды.
      }
      if (cancelled || sessionPersistenceOwnerRef.current !== sessionOwner) return;
      // Сервер мог отстать от вкладки на доли секунды, если dev-сервер или браузер
      // перезагрузил страницу между локальной записью и отложенным PUT. Объединяем оба
      // снимка, чтобы свежий пост из чата не исчезал за более старой серверной версией.
      const restored = remoteSession && localSession
        ? mergeStudioChatSessions(remoteSession, localSession)
        : remoteSession ?? localSession;
      sessionRevisionRef.current = revision;
      setMessages(restored?.messages ?? []);
      setDraft(restored?.draft ?? "");
      setWorkspaceMode(requestedWorkspaceMode ?? restored?.workspaceMode ?? "chat");
      genRef.current = new Map(restored?.generations ?? []);
      setChatSessionOwner(sessionOwner);
      setChatPersistenceStatus(serverUnavailable ? "local" : localSession ? "saving" : "saved");
    })();

    return () => {
      cancelled = true;
    };
  }, [chatSessionOwner, requestedWorkspaceMode, s.authReady, sessionOwner]);

  // Локальную копию обновляем сразу, а PostgreSQL — после короткой паузы и строго
  // последовательно. Так streaming не создаёт запрос на каждый токен, но готовый текст
  // уже не зависит от жизни вкладки. Revision защищает историю от устаревшей вкладки.
  useEffect(() => {
    if (!sessionOwner || chatSessionOwner !== sessionOwner) return;
    const session = {
      messages,
      draft,
      workspaceMode,
      generations: [...genRef.current.entries()],
    };
    const serialized = serializeStudioChatSession(sessionOwner, session);
    latestSessionSnapshotRef.current = { owner: sessionOwner, serialized };
    try {
      const key = studioChatStorageKey(sessionOwner);
      localStorage.setItem(key, serialized);
      sessionStorage.removeItem(key);
    } catch {
      // Недоступный storage не должен ломать серверное сохранение.
    }
    if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    sessionSaveTimerRef.current = setTimeout(() => {
      const owner = sessionOwner;
      setChatPersistenceStatus("saving");
      sessionSaveQueueRef.current = sessionSaveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (sessionPersistenceOwnerRef.current !== owner) return;
          let payload = JSON.parse(serialized) as unknown;
          let expectedRevision = sessionRevisionRef.current;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const response = await fetch("/api/studio/session", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ expectedRevision, session: payload }),
            });
            const body = (await response.json().catch(() => null)) as {
              session?: unknown;
              revision?: number;
            } | null;
            if (response.ok && Number.isSafeInteger(body?.revision)) {
              if (sessionPersistenceOwnerRef.current === owner) {
                sessionRevisionRef.current = Number(body?.revision);
                setChatPersistenceStatus("saved");
              }
              return;
            }
            if (response.status !== 409 || !body?.session || !Number.isSafeInteger(body.revision)) {
              throw new Error("session_save_failed");
            }
            const remote = parseStudioChatSession(JSON.stringify(body.session), owner);
            const local = parseStudioChatSession(JSON.stringify(payload), owner);
            if (!remote || !local) throw new Error("session_conflict_invalid");
            expectedRevision = Number(body.revision);
            payload = JSON.parse(serializeStudioChatSession(owner, mergeStudioChatSessions(remote, local))) as unknown;
          }
          throw new Error("session_conflict_repeated");
        })
        .catch(() => {
          if (sessionPersistenceOwnerRef.current === owner) setChatPersistenceStatus("local");
        });
    }, 600);
    return () => {
      if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
    };
  }, [chatSessionOwner, draft, messages, sessionOwner, workspaceMode]);

  // Последняя синхронная страховка на случай Fast Refresh, рестарта dev-сервера или
  // перезагрузки браузера. localStorage записывается до ухода страницы; небольшой снимок
  // дополнительно отправляем с keepalive, не задерживая навигацию.
  useEffect(() => {
    const persistOnPageHide = () => {
      const snapshot = latestSessionSnapshotRef.current;
      if (!snapshot || snapshot.owner !== sessionPersistenceOwnerRef.current) return;
      try {
        localStorage.setItem(studioChatStorageKey(snapshot.owner), snapshot.serialized);
      } catch {
        // Серверное сохранение всё равно могло завершиться до закрытия страницы.
      }
      if (new Blob([snapshot.serialized]).size > 60_000) return;
      void fetch("/api/studio/session", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: sessionRevisionRef.current,
          session: JSON.parse(snapshot.serialized) as unknown,
        }),
        credentials: "same-origin",
        keepalive: true,
      }).catch(() => undefined);
    };
    window.addEventListener("pagehide", persistOnPageHide);
    return () => window.removeEventListener("pagehide", persistOnPageHide);
  }, []);

  useEffect(() => () => {
    if (sessionSaveTimerRef.current) clearTimeout(sessionSaveTimerRef.current);
  }, []);

  const busy = messages.some((m) => m.streaming);
  const streamingLen = messages.find((m) => m.streaming)?.text.length ?? 0;
  const count = messages.length;

  const aiUsage = getAiUsageMetrics(s.aiUsageStatus, s.aiUsed, s.aiLimit);
  const persistenceLabel = chatPersistenceStatus === "loading"
    ? "Восстанавливаю историю…"
    : chatPersistenceStatus === "saving"
      ? "Сохраняю историю…"
      : chatPersistenceStatus === "local"
        ? "Сервер временно недоступен — история сохранена на этом устройстве"
        : "История сохранена";
  const activeChannels = s.realChannels.filter((channel) => channel.is_active);
  const channelId =
    pickedChannelId && activeChannels.some((channel) => channel.id === pickedChannelId)
      ? pickedChannelId
      : (activeChannels[0]?.id ?? null);

  // Новое сообщение — прокручиваем ленту вниз (уважая настройку «меньше движения»).
  // block: "nearest" — двигается только лента, страница под ней остаётся на месте.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "nearest" });
  }, [count, reduce]);

  // Пока печатает — держим хвост в виду. Но если человек ушёл читать выше, скролл не вырываем.
  useEffect(() => {
    const el = feedRef.current;
    if (!el || streamingLen === 0) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap < 160) el.scrollTop = el.scrollHeight;
  }, [streamingLen]);

  // Поле растёт вместе с сообщением до разумного предела, затем прокручивается внутри.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  // Уходим с экрана — печать останавливается.
  useEffect(() => {
    const box = streamRef.current;
    return () => {
      abortStudioStream(box);
    };
  }, []);

  const savePostSettings = async (next: PostSettings) => {
    if (postSettingsSaving) return;
    const previous = postSettings;
    const normalized = normalizePostSettings(next);
    setPostSettings(normalized);
    setPostSettingsSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postSettings: normalized }),
      });
      const result = await response.json().catch(() => null) as { postSettings?: unknown } | null;
      if (!response.ok || !result?.postSettings) throw new Error("settings save failed");
      setPostSettings(normalizePostSettings(result.postSettings));
      s.toast({ kind: "success", title: "Настройки публикации сохранены" });
    } catch {
      setPostSettings(previous);
      s.toast({
        kind: "danger",
        title: "Не удалось сохранить настройки",
        body: "Изменения отменены. Проверь соединение и попробуй ещё раз.",
      });
    } finally {
      setPostSettingsSaving(false);
    }
  };

  // Library navigation carries only an owned server draft id. Reference text and source
  // metadata are fetched through the authenticated draft API, never copied into the URL.
  useEffect(() => {
    if (chatSessionOwner !== sessionOwner || sessionOwner == null) return;
    const requestedDraftId = Number(searchParams.get("draft"));
    if (!Number.isSafeInteger(requestedDraftId) || requestedDraftId <= 0) return;
    const controller = new AbortController();
    void getServerDraft(requestedDraftId, controller.signal)
      .then((serverDraft) => {
        if (
          (
            serverDraft.origin !== "competitor" && serverDraft.origin !== "trend" &&
            serverDraft.origin !== "idea" && serverDraft.origin !== "rss"
          )
          || !serverDraft.source_ref
        ) return;
        const destination = serverDraft.destinations.find((item) => item.is_active);
        setContextDraft(serverDraft);
        setPendingLibraryReference({
          text: serverDraft.text.trim().slice(0, 4000),
          source: serverDraft.source_ref.label.trim().slice(0, 160) || undefined,
        });
        if (destination) setPickedChannelId(destination.channel_id);
        if (searchParams.get("intent") === "create" && destination) {
          const adaptation = buildLibraryAdaptation({
            channelName: destination?.title || "выбранного канала",
            text: serverDraft.text,
            source: serverDraft.source_ref.label,
            topic: serverDraft.source_ref.topic,
          });
          const requestedCalendarDate = searchParams.get("calendarDate");
          const calendarDate = requestedCalendarDate && /^\d{4}-\d{2}-\d{2}$/u.test(requestedCalendarDate)
            ? requestedCalendarDate : null;
          const calendarLabel = calendarDate
            ? new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" })
              .format(new Date(`${calendarDate}T12:00:00.000Z`))
            : null;
          const prompt = calendarLabel
            ? `${adaptation.prompt}\n\nЭтот материал предназначен для свободного окна ${calendarLabel}. Не вставляй дату в текст автоматически; после создания пользователь отдельно подтвердит расписание.`
            : adaptation.prompt;
          const identity = studioReferenceGenerationIdentity(serverDraft.id, serverDraft.version);
          const isLegalOpportunity = serverDraft.origin === "rss"
            && serverDraft.source_ref.factualGrounding === "curated_legal_source";
          const variant = isLegalOpportunity
            ? legalOpportunityVariantFromClientKey(serverDraft.client_key)
            : undefined;
          setWorkspaceMode("chat");
          setDraft(prompt);
          setPendingReferenceGeneration({
            draftId: serverDraft.id,
            version: serverDraft.version,
            prompt,
            channelId: destination.channel_id,
            network: destination.network,
            ...(variant ? { variant, suggestMedia: true } : {}),
            ...identity,
          });
        }
      })
      .catch((error) => {
        if ((error as Error)?.name === "AbortError") return;
        setContextDraft(null);
        setPendingLibraryReference(null);
      });
    return () => controller.abort();
  }, [chatSessionOwner, searchParams, sessionOwner]);

  // A question URL carries only a project-owned id. The server returns the exact
  // editorial prompt and stable request keys created by the explicit "Создать ответ"
  // action, so refresh safely replays the same generation instead of spending twice.
  useEffect(() => {
    if (chatSessionOwner !== sessionOwner || sessionOwner == null) return;
    const questionId = Number(searchParams.get("audienceQuestion"));
    if (
      searchParams.get("intent") !== "create"
      || !Number.isSafeInteger(questionId)
      || questionId <= 0
    ) return;
    const controller = new AbortController();
    void fetch(`/api/audience-questions/${questionId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as {
          question?: {
            id: number;
            version: number;
            status: string;
            generationRequestKey: string | null;
            draftClientKey: string | null;
          };
          generationPrompt?: string;
        } | null;
        if (!response.ok || !body?.question || typeof body.generationPrompt !== "string") {
          throw new Error("question_load_failed");
        }
        if (
          body.question.status !== "drafting"
          || !body.question.generationRequestKey
          || !body.question.draftClientKey
        ) throw new Error("question_not_started");
        setWorkspaceMode("chat");
        setPendingAudienceQuestionGeneration({
          questionId: body.question.id,
          questionVersion: body.question.version,
          prompt: body.generationPrompt,
          requestKey: body.question.generationRequestKey,
          resultClientKey: body.question.draftClientKey,
        });
      })
      .catch((error) => {
        if ((error as Error)?.name === "AbortError") return;
        showToast({
          kind: "danger",
          title: "Не удалось открыть вопрос",
          body: "Вернитесь в запросы аудитории и повторите создание ответа.",
        });
      });
    return () => controller.abort();
  }, [chatSessionOwner, searchParams, sessionOwner, showToast]);

  useEffect(() => {
    if (chatSessionOwner !== sessionOwner || sessionOwner == null) return;
    const moveId = Number(searchParams.get("growthMove"));
    if (
      searchParams.get("intent") !== "create"
      || !Number.isSafeInteger(moveId)
      || moveId <= 0
    ) return;
    const controller = new AbortController();
    void fetch(`/api/growth/moves/${moveId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { move?: { prompt?: string } } | null;
        if (!response.ok || typeof body?.move?.prompt !== "string") throw new Error("growth_move_load_failed");
        growthMoveIdRef.current = moveId;
        setWorkspaceMode("chat");
        setDraft(body.move.prompt);
      })
      .catch((error) => {
        if ((error as Error)?.name === "AbortError") return;
        showToast({
          kind: "danger",
          title: "Не удалось открыть ход",
          body: "Вернись в Развитие и нажми «Сделать» ещё раз.",
        });
      });
    return () => controller.abort();
  }, [chatSessionOwner, searchParams, sessionOwner, showToast]);

  // A monthly topic URL carries only owned ids. The write prompt is built here
  // from the campaign API and left in the input — the user sends it, or not.
  useEffect(() => {
    if (chatSessionOwner !== sessionOwner || sessionOwner == null) return;
    const campaignId = Number(searchParams.get("monthlyCampaign"));
    const planId = Number(searchParams.get("monthlyPlan"));
    const itemId = Number(searchParams.get("monthlyItem"));
    const channelFromUrl = Number(searchParams.get("channel"));
    if (
      searchParams.get("intent") !== "create"
      || !Number.isSafeInteger(campaignId)
      || campaignId <= 0
      || !Number.isSafeInteger(planId)
      || planId <= 0
      || !Number.isSafeInteger(itemId)
      || itemId <= 0
    ) return;
    if (loadedMonthlyItemsRef.current.has(itemId)) return;
    const controller = new AbortController();
    void fetch(`/api/monthly-campaigns/${campaignId}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        const detail = parseMonthlyCampaignDetail(body);
        const plan = detail?.plans.find((entry) => entry.id === planId);
        const item = plan?.items.find((entry) => entry.id === itemId);
        if (!response.ok || !detail || !plan || !item) throw new Error("monthly_item_load_failed");
        const prompt = monthlyCampaignStudioPrompt({
          title: item.title,
          rubric: item.rubric,
          practice: item.practice,
          audience: detail.campaign.audience,
          goal: detail.campaign.goal,
          cta: detail.campaign.ctas[0],
        });
        const destinationChannelId = Number.isSafeInteger(channelFromUrl) && channelFromUrl > 0
          ? channelFromUrl
          : null;
        loadedMonthlyItemsRef.current.add(itemId);
        monthlyCampaignContextRef.current = { campaignId, planId, itemId };
        if (destinationChannelId) setPickedChannelId(destinationChannelId);
        setWorkspaceMode("chat");
        setDraft(prompt);
        window.history.replaceState(null, "", "/app/studio?mode=chat");
        queueMicrotask(() => inputRef.current?.focus());
      })
      .catch((error) => {
        if ((error as Error)?.name === "AbortError") return;
        showToast({
          kind: "danger",
          title: "Не удалось открыть тему месяца",
          body: "Вернись в кампанию и нажми «Подготовить в Студии» ещё раз.",
        });
      });
    return () => controller.abort();
  }, [chatSessionOwner, searchParams, sessionOwner, showToast]);

  // Технические параметры генерации загружаются из базы; голос канала приходит
  // в серверный контекст из единого поканального профиля Авроры.
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setPostSettings(normalizePostSettings(d.postSettings));
      })
      .catch(() => {})
      .finally(() => setPostSettingsReady(true));
  }, []);

  // Чат должен быть ФИКСИРОВАННОЙ коробки: сообщения ездят внутри, поле ввода не двигается.
  // Раньше стояли min-h/max-h — контейнер рос под содержимое и толкал ввод вниз при каждом
  // новом сообщении. Высоту считаем от реального положения блока, а не магическим числом:
  // подзаголовок может перенестись на две строки, и константа сразу бы соврала.
  const shellRef = useRef<HTMLDivElement | null>(null);
  const designShellRef = useRef<HTMLDivElement | null>(null);

  const fit = useCallback(() => {
    for (const el of [shellRef.current, designShellRef.current]) {
      if (!el) continue;
      const viewport = window.visualViewport;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportTop = viewport?.offsetTop ?? 0;
      const top = Math.max(0, el.getBoundingClientRect().top - viewportTop);
      // Нижний отступ берём у main, а не константой: на телефоне там pb-24 под нижнее меню,
      // на десктопе pb-10. Зашитое число увело бы ввод под панель навигации.
      const main = el.closest("main");
      const bottom = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 40;
      const available = Math.max(240, viewportHeight - top - bottom);
      el.style.setProperty("--studio-h", `${available}px`);
    }
  }, []);

  // Меряем в момент появления узла, а не в эффекте страницы: AppShell держит собственный
  // скелет, пока грузится сам, поэтому к моменту любого useEffect этой страницы div ещё
  // не смонтирован и ref пустой. Ref-колбэк срабатывает ровно тогда, когда узел появился.
  const attachShell = useCallback(
    (el: HTMLDivElement | null) => {
      shellRef.current = el;
      if (el) fit();
    },
    [fit],
  );

  const attachDesignShell = useCallback(
    (el: HTMLDivElement | null) => {
      designShellRef.current = el;
      if (el) fit();
    },
    [fit],
  );

  useEffect(() => {
    window.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("scroll", fit);
    return () => {
      window.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("scroll", fit);
    };
  }, [fit]);

  // При переключении оба режима снова подгоняются под доступную высоту экрана.
  useEffect(() => {
    const frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [fit, workspaceMode]);

  // Движки ИИ — состояние живёт здесь: чип у поля ввода и отказ генерации должны знать одно и то же.
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [engine, setEngine] = useState<string | null>(null);
  const [enginesLoading, setEnginesLoading] = useState(true);
  const [engineStatusError, setEngineStatusError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/ai/engines", { cache: "no-store" })
      .then(async (response) => ({
        response,
        data: await response.json().catch(() => null) as {
          engines?: EngineInfo[];
          current?: string;
          suggestedEngine?: EngineInfo | null;
          error?: string;
          requestId?: string;
        } | null,
      }))
      .then(({ response, data: d }) => {
        if (!response.ok || !d) {
          setEngineStatusError("Не удалось проверить модели. Проверь соединение и обнови страницу.");
          return;
        }
        setEngineStatusError(null);
        const availableEngines = d.engines ?? [];
        setEngines(availableEngines);
        setEngine(d.current ?? null);
        setPendingEngineSuggestion(
          d.suggestedEngine?.id
            ? availableEngines.find((item) => item.id === d.suggestedEngine?.id && item.status === "ready") ?? null
            : null,
        );
      })
      .catch(() => setEngineStatusError("Не удалось проверить модели. Проверь соединение и обнови страницу."))
      .finally(() => setEnginesLoading(false));
  }, []);

  const pickEngine = async (e: EngineInfo) => {
    if (!e.supported || e.status !== "ready") return;
    const response = await fetch("/api/ai/engines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: e.id }),
    }).catch(() => null);
    if (!response?.ok) {
      const info = await response?.json().catch(() => null) as { requestId?: string; error?: string } | null;
      s.toast({
        kind: "danger",
        title: "Не удалось сменить модель",
        body: info?.error === "engine_offline" ? "Модель сейчас не отвечает." : "Проверь подключение и попробуй ещё раз.",
      });
      return;
    }
    setEngine(e.id);
    setPendingEngineSuggestion(null);
    s.toast({ kind: "success", title: `Выбрана модель ${e.label}` });
  };

  /* ------------------------------------------------------------ ДЕЙСТВИЯ */

  const limitToast = () => {
    if (!aiUsage) return;
    s.toast({
      kind: "danger",
      title: "Лимит на сегодня исчерпан",
      body: `${aiUsage.limit} генераций в сутки — честный лимит, ИИ стоит денег. Обновится завтра.`,
    });
  };


  // Готовый ответ сразу становится серверным черновиком. Публикация остаётся явным
  // действием в редакторе: там можно отправить сейчас, выбрать дату или подтвердить факты.
  function openAsPost(messageId: string, text: string, options?: {
    channelId?: number | null;
    clientKey?: string;
    generationResultId?: number;
  }) {
    if (postDraftRef.current.promise) return;
    const destinationChannelId = options?.channelId ?? channelId;
    if (!destinationChannelId) {
      s.toast({
        kind: "danger",
        title: "Некуда отправлять пост",
        body: "Сначала подключи или выбери активный канал.",
      });
      return;
    }

    const clientKey = options?.clientKey
      ?? postDraftRef.current.keys.get(messageId)
      ?? createDraftClientKey();
    const generation = genRef.current.get(messageId);
    const generatedMessage = messages.find((message) => message.id === messageId);
    const generationResultId = options?.generationResultId ?? generatedMessage?.generationResultId;
    if (!generationResultId) {
      s.toast({
        kind: "danger",
        title: "Текст ещё нельзя открыть в редакторе",
        body: "Сервер не подтвердил точный результат и его проверки. Исправь задание и запусти генерацию снова.",
      });
      return;
    }
    postDraftRef.current.keys.set(messageId, clientKey);
    setCreatingPostId(messageId);
    const request = (async () => {
      try {
        const result = await createServerDraft({
          text,
          media: null,
          scheduledAt: null,
          origin: "ai",
          sourceRef: null,
          channelIds: [destinationChannelId],
          aiValidation: null,
          generationResultId,
          clientKey,
          growthMoveId: growthMoveIdRef.current,
        });
        if (growthMoveIdRef.current != null) {
          growthMoveIdRef.current = null;
          window.history.replaceState(null, "", "/app/studio?mode=chat");
        }
        if (generation?.audienceQuestionId && generation.audienceQuestionVersion) {
          try {
            const linkResponse = await fetch(`/api/audience-questions/${generation.audienceQuestionId}/draft`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                generationRequestKey: generation.audienceQuestionGenerationKey,
                answerDraftId: result.draft.id,
              }),
            });
            if (!linkResponse.ok) throw new Error("question_link_failed");
          } catch {
            s.toast({
              kind: "info",
              title: "Пост создан, но связь с вопросом не обновилась",
              body: "Черновик сохранён. В запросах аудитории вопрос можно отметить отвеченным вручную.",
            });
          }
          window.history.replaceState(null, "", "/app/studio?mode=chat");
        }
        if (generation?.monthlyCampaignId && generation.monthlyPlanId && generation.monthlyItemId) {
          try {
            const linkResponse = await fetch(
              `/api/monthly-campaigns/${generation.monthlyCampaignId}/plans/${generation.monthlyPlanId}/items/${generation.monthlyItemId}/draft`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  channelId: destinationChannelId,
                  draftId: result.draft.id,
                }),
              },
            );
            if (!linkResponse.ok) throw new Error("monthly_link_failed");
          } catch {
            s.toast({
              kind: "info",
              title: "Пост создан, но день кампании не обновился",
              body: "Черновик сохранён. Связь с темой месяца можно повторить позже.",
            });
          }
          window.history.replaceState(null, "", "/app/studio?mode=chat");
          s.toast({
            kind: "success",
            title: "Пост создан",
            body: "Открываем редактор — можно опубликовать сразу или запланировать.",
          });
          router.push(`/app/composer?draft=${result.draft.id}&from=autopilot-month`);
          return;
        }
        s.toast({
          kind: "success",
          title: "Пост создан",
          body: "Открываем редактор — можно опубликовать сразу или запланировать.",
        });
        if (generation?.autoOpenComposer && generation.referenceDraftId) {
          // Only now is it safe to consume the one-shot intent: the generated text already
          // has a durable, idempotent draft. Back returns to Studio without starting again.
          window.history.replaceState(null, "", `/app/studio?draft=${generation.referenceDraftId}`);
        }
        const suggestMedia = generation?.suggestMedia ? "&suggestMedia=1" : "";
        router.push(`/app/composer?draft=${result.draft.id}&from=studio${suggestMedia}`);
      } catch (error) {
        s.toast({
          kind: "danger",
          title: "Пост не создан",
          body:
            error instanceof DraftRequestError && error.kind === "offline"
              ? "Нет связи с сервером. Текст остался в чате — повтори, когда соединение восстановится."
              : "Черновик не удалось сохранить. Текст остался в чате, можно безопасно повторить.",
        });
      } finally {
        postDraftRef.current.promise = null;
        setCreatingPostId(null);
      }
    })();
    postDraftRef.current.promise = request;
  }


  // Настоящая генерация Д.8: стрим из /api/ai/generate (за ним переходник → Hermes).
  // Сервер подкладывает прошлые посты как образец стиля и считает дневной лимит.
  const startStream = async (id: string, gen: Gen) => {
    const requestKey = gen.requestKey ?? crypto.randomUUID();
    if (!gen.requestKey) {
      gen = { ...gen, requestKey };
      genRef.current.set(id, gen);
    }
    const previousMessage = messages.find((message) => message.id === id && !message.streaming);
    const previousText = previousMessage?.text ?? "";
    const streamBox = streamRef.current;
    const streamOwner = beginStudioStream(streamBox);
    const controller = streamOwner.controller;
    const ownsStream = () => ownsStudioStream(streamBox, streamOwner);

    const clearCancel = () => {
      clearStudioStream(streamBox, streamOwner);
    };
    const generationSettings = gen.postSettings ?? postSettings;
    const generationChannelId = gen.channelId !== undefined ? gen.channelId : channelId;
    const variantInstruction: Record<PostSettings["variantChange"], string> = {
      full: "полностью другая концепция",
      hook: "новый хук при сохранении фактов",
      sales_angle: "новый угол продажи",
      structure: "другая структура",
      emotional: "более эмоциональная подача",
      expert: "более экспертная подача",
      native: "более нативная подача для площадки",
    };
    const setMsg = (patch: Partial<Msg>) => {
      if (!ownsStream()) return false;
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
      return true;
    };
    const failureText = aiFailureRecoveryRu;

    try {
      const res = await fetch("/api/ai/generate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": requestKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          command: gen.cmd,
          input: gen.variant > 0
            ? `${gen.input}\n\nДля нового варианта используй: ${variantInstruction[generationSettings.variantChange]}. Не повторяй предыдущую формулировку.`
            : gen.input,
          channelId: generationChannelId,
          history: gen.history,
          postSettings: generationSettings,
          referenceText: gen.referenceText,
          referenceSource: gen.referenceSource,
          referenceDraftId: gen.referenceDraftId,
          referenceDraftVersion: gen.referenceDraftVersion,
          referenceIntent: gen.referenceIntent,
          monthlyCampaignId: gen.monthlyCampaignId,
          monthlyPlanId: gen.monthlyPlanId,
          monthlyItemId: gen.monthlyItemId,
          // Для draft-backed adaptation сервер сам загружает тему, provenance и недоверенный
          // источник; клиент передаёт только draft id/version. Старый inline reference остаётся
          // лишь для обратной совместимости discuss-flow.
          surface: "studio",
        }),
      });
      const responseRequestId = res.headers.get("x-ai-request-id") ?? undefined;
      if (responseRequestId) setMsg({ requestId: responseRequestId });

      if ([400, 401, 403, 409, 422, 429, 503].includes(res.status)) {
        const info = (await res.json().catch(() => null)) as
          | Omit<AiFailureInfo, "issues"> & {
              conflicts?: Array<{ message?: string }>;
              issues?: Array<string | { message?: string }>;
            }
          | null;
        if (!ownsStream()) return;
        const correlatedRequestId = info?.requestId ?? responseRequestId;
        const details = info?.conflicts?.map((item) => item.message).filter(Boolean).join("\n• ");
        const preflight = info?.issues
          ?.map((item) => typeof item === "string" ? item : item.message)
          .filter((item): item is string => Boolean(item))
          .join("\n• ");
        const failureInfo: AiFailureInfo | null = info
          ? { ...info, issues: info.issues?.map((item) => typeof item === "string" ? item : item.message).filter((item): item is string => Boolean(item)) }
          : null;
        const suggested = info?.suggestedEngine?.id
          ? engines.find((item) => item.id === info.suggestedEngine?.id && item.status === "ready") ?? null
          : null;
        setPendingEngineSuggestion(suggested);
        if (res.status === 429) limitToast();
        setMsg({
          text: info?.error === "post_settings_conflict" && details
            ? `Проверь настройки перед генерацией:\n• ${details}`
            : info?.error === "brief_insufficient_facts" && preflight
              ? `Не могу безопасно выдержать заданный объём:\n• ${preflight}`
              : previousText,
          errorMessage: info?.error === "post_settings_conflict" && details
            ? `Исправь конфликтующие настройки и повтори запрос.\n• ${details}`
            : info?.error === "brief_insufficient_facts" && preflight
              ? `Добавь подтверждённые факты и повтори запрос.\n• ${preflight}`
              : res.status === 429
                ? "Дневной лимит исчерпан. Текст запроса сохранён; повтори его после обновления лимита."
                : failureText(failureInfo, res.status),
          requestId: correlatedRequestId,
          streaming: false,
          progressLabel: undefined,
          postable: false,
          reviewable: false,
          interrupted: true,
          retryable: res.status === 429 || info?.retryable === true,
        });
        clearCancel();
        void s.refreshAiUsage();
        return;
      }
      if (!res.ok || !res.body) {
        if (!ownsStream()) return;
        setMsg({
          text: previousText,
          errorMessage: `Не удалось получить ответ от сервера (код ${res.status}). Повтори тот же запрос.`,
          requestId: responseRequestId,
          streaming: false,
          progressLabel: undefined,
          postable: false,
          reviewable: false,
          interrupted: true,
          retryable: true,
        });
        clearCancel();
        return;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      if (res.headers.get("content-type")?.includes("application/x-ndjson")) {
        let buffer = "";
        let projection = createAiDraftProjection(previousText);
        let failed = false;
        let validationBlocked = false;
        let validationRequiresReview = false;
        let validationReceived = false;
        let doneReceived = false;
        let fallbackNoticeShown = false;
        let terminalValidation: Msg["aiValidation"];
        let effectiveEngineId: string | undefined;
        let requestedEngineId: string | undefined = engine ?? undefined;
        let fallbackUsed = false;
        let replayed = false;
        let terminalGenerationResultId: number | undefined;
        let terminalRequestId = responseRequestId;
        const applyEvent = (event: AiStreamEvent) => {
          if (!ownsStream()) return;
          terminalRequestId = event.requestId;
          if (event.type === "phase") {
            projection = projectAiDraftEvent(projection, event);
            setMsg({
              progressLabel: aiDraftPhaseLabel(projection.phase),
              postable: false,
              requestId: event.requestId,
            });
          } else if (event.type === "delta") {
            projection = projectAiDraftEvent(projection, event);
            setMsg({
              text: projection.visibleText,
              requestId: event.requestId,
            });
          } else if (event.type === "replace") {
            projection = projectAiDraftEvent(projection, event);
            setMsg({
              text: projection.visibleText,
              requestId: event.requestId,
            });
          } else if (event.type === "fallback") {
            fallbackUsed = true;
            requestedEngineId = event.fromEngine;
            effectiveEngineId = event.toEngine;
            if (!fallbackNoticeShown) {
              fallbackNoticeShown = true;
              const from = engines.find((item) => item.id === event.fromEngine)?.label ?? event.fromEngine;
              const to = engines.find((item) => item.id === event.toEngine)?.label ?? event.toEngine;
              s.toast({
                kind: "info",
                title: "Ответ создаёт резервная модель",
                body: `${from} не ответила до начала текста. Этот ответ создаёт ${to}; выбранная модель в настройках не меняется.`,
              });
            }
          } else if (event.type === "validation") {
            validationReceived = true;
            validationBlocked = event.status !== "passed";
            validationRequiresReview = event.requiresReview;
            terminalValidation = {
              version: 1,
              status: event.status,
              requiresReview: event.requiresReview,
              provenance: event.provenance,
              blockerCodes: event.blockerCodes,
              ...(event.topicAlignment ? { topicAlignment: event.topicAlignment } : {}),
            };
          } else if (event.type === "done") {
            projection = projectAiDraftEvent(projection, event);
            doneReceived = true;
            effectiveEngineId = event.engine ?? effectiveEngineId;
            requestedEngineId = event.requestedEngine ?? requestedEngineId;
            fallbackUsed = event.fallbackUsed ?? fallbackUsed;
            replayed = event.replayed === true;
            terminalGenerationResultId = event.generationResultId;
          } else if (event.type === "error") {
            failed = true;
            const suggested = event.suggestedEngine?.id
              ? engines.find((item) => item.id === event.suggestedEngine?.id && item.status === "ready") ?? null
              : null;
            setPendingEngineSuggestion(suggested);
            setMsg({
              text: previousText,
              errorMessage: failureText(event),
              progressLabel: undefined,
              requestId: event.requestId,
              streaming: false,
              postable: false,
              reviewable: false,
              requiresReview: false,
              interrupted: true,
              retryable: event.retryable === true,
            });
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          const parsed = parseAiStreamBuffer(buffer);
          buffer = parsed.rest;
          parsed.events.forEach(applyEvent);
        }
        buffer += dec.decode();
        if (buffer.trim()) parseAiStreamBuffer(`${buffer}\n`).events.forEach(applyEvent);
        if (!ownsStream()) return;
        const completion = finalizeAiClientStream({
          text: projection.buffer || projection.visibleText,
          failed,
          validationReceived,
          doneReceived,
          validationBlocked,
          validationRequiresReview,
        });
        if (completion.status === "truncated") {
          setMsg({
            text: previousText || completion.partialText,
            errorMessage: completion.partialText
              ? "Ответ оборвался до подтверждения завершения. Частичный текст сохранён — его можно скопировать или безопасно повторить запрос."
              : "Ответ оборвался до подтверждения завершения. Повтори тот же запрос: сохранённый результат будет восстановлен без двойного списания.",
            progressLabel: undefined,
            requestId: terminalRequestId,
            streaming: false,
            postable: false,
            reviewable: false,
            requiresReview: false,
            interrupted: true,
            retryable: true,
          });
        }
        if (completion.status === "complete") {
          let acknowledgedGenerationResultId: number;
          try {
            const acknowledged = await acknowledgeAiTerminal(requestKey, { signal: controller.signal });
            acknowledgedGenerationResultId = acknowledged.generationResultId;
            if (
              terminalGenerationResultId != null
              && terminalGenerationResultId !== acknowledgedGenerationResultId
            ) throw new AiTerminalAckError(409, terminalRequestId ?? null, false);
          } catch (error) {
            if ((error as Error)?.name === "AbortError") throw error;
            const ackRequestId = error instanceof AiTerminalAckError ? error.requestId : null;
            setMsg({
              text: completion.text,
              errorMessage: "Ответ получен, но подтверждение списания не завершилось. Повтори тот же запрос: сохранённый результат вернётся без нового вызова модели.",
              progressLabel: undefined,
              requestId: ackRequestId ?? terminalRequestId,
              streaming: false,
              postable: false,
              reviewable: false,
              requiresReview: false,
              interrupted: true,
              retryable: true,
            });
            clearCancel();
            void s.refreshAiUsage();
            return;
          }
          setMsg({
            text: completion.text,
            // Готовый черновик говорит сам за себя. Требование ручной проверки остаётся —
            // его показывает композер перед планированием и проверяет сервер при публикации.
            statusMessage: undefined,
            progressLabel: undefined,
            streaming: false,
            postable: completion.postable,
            reviewable: completion.reviewable,
            requiresReview: completion.requiresReview,
            aiValidation: terminalValidation,
            requestId: terminalRequestId,
            errorMessage: undefined,
            interrupted: false,
            retryable: false,
            requestedEngine: requestedEngineId
              ? engines.find((item) => item.id === requestedEngineId)?.label ?? requestedEngineId
              : undefined,
            effectiveEngine: effectiveEngineId
              ? engines.find((item) => item.id === effectiveEngineId)?.label ?? effectiveEngineId
              : undefined,
            fallbackUsed,
            replayed,
            generationResultId: acknowledgedGenerationResultId,
          });
          // Любой подтверждённый terminal-result доступен как черновик. Блокирующая
          // проверка запрещает тихую автопубликацию, но не отбирает текст у человека.
          if (gen.autoOpenComposer && completion.reviewable) {
            openAsPost(id, completion.text, {
              channelId: generationChannelId,
              clientKey: gen.resultClientKey,
              generationResultId: acknowledgedGenerationResultId,
            });
          }
        }
        clearCancel();
        void s.refreshAiUsage();
        return;
      }

      let acc = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
      }
      if (!ownsStream()) return;
      setMsg({
        text: acc,
        streaming: false,
        progressLabel: undefined,
        postable: Boolean(acc.trim()),
      });
      clearCancel();
      void s.refreshAiUsage();
    } catch (err) {
      // «Стоп» пользователя = AbortError: просто фиксируем, что успело напечататься.
      const aborted = (err as Error)?.name === "AbortError";
      if (ownsStream()) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id
              ? {
                  ...m,
                  streaming: false,
                  text: previousText || (isStudioGenerationPlaceholder(m.text) ? "" : m.text),
                  progressLabel: undefined,
                  errorMessage: aborted
                    ? "Генерация остановлена. Частичный текст сохранён; повтор использует тот же ключ запроса."
                    : "Связь с ИИ прервалась. Проверь соединение и повтори тот же запрос — текст и ключ сохранены.",
                  postable: false,
                  reviewable: false,
                  requiresReview: false,
                  interrupted: true,
                  retryable: true,
                }
              : m,
          ),
        );
        clearCancel();
      }
      void s.refreshAiUsage();
    }
  };

  const ask = (userText: string, opts?: AskOptions) => {
    const text = userText.trim() || postSettings.mainIdea.trim();
    if (!text || streamRef.current.current) return;

    // Честный дневной лимит (ТЗ 12): оптимистично проверяем на клиенте, сервер — финальный судья.
    if (aiUsage?.exhausted) {
      limitToast();
      return;
    }

    const history: ConversationTurn[] = opts?.autoOpenComposer ? [] : messages
      .filter((message) => message.text.trim() && !message.streaming)
      .map((message) => ({
        role: message.role === "ai" ? ("assistant" as const) : ("user" as const),
        content: message.text,
      }))
      .slice(-8);
    const hasAnswer = history.some((turn) => turn.role === "assistant");
    const detected = opts?.cmd ?? pickStudioCommand(text);
    const cmd = !opts?.cmd && detected === "write" && hasAnswer && looksLikeEditFollowUp(text)
      ? "rewrite"
      : detected;
    const needsConfirmation = requiresBriefConfirmation({
      text,
      hasBlockers: validatePostSettingsConflicts(postSettings).some(
        (conflict) => conflict.severity === "error",
      ),
    });
    if (!opts?.skipBrief && (cmd === "write" || cmd === "longread") && needsConfirmation) {
      setPendingBrief({ text, opts: opts ? { cmd: opts.cmd, input: opts.input } : undefined });
      return;
    }
    setPendingBrief(null);
    const monthly = monthlyCampaignContextRef.current;
    const destination = opts?.channelId ?? channelId;
    const gen: Gen = {
      cmd,
      input: opts?.input ?? text,
      variant: 0,
      history,
      requestKey: opts?.requestKey ?? crypto.randomUUID(),
      referenceText: contextDraft ? undefined : pendingLibraryReference?.text,
      referenceSource: contextDraft ? undefined : pendingLibraryReference?.source,
      sourceRef: contextDraft?.source_ref ?? undefined,
      referenceDraftId: opts?.referenceDraftId ?? contextDraft?.id,
      referenceDraftVersion: opts?.referenceDraftVersion ?? contextDraft?.version,
      referenceIntent: opts?.autoOpenComposer ? "create" : contextDraft ? "discuss" : undefined,
      channelId: destination,
      postSettings: opts?.postSettings ?? postSettings,
      autoOpenComposer: opts?.autoOpenComposer,
      resultClientKey: opts?.resultClientKey
        ?? (monthly && destination ? `monthly-item-studio:${monthly.itemId}:${destination}` : undefined),
      audienceQuestionId: opts?.audienceQuestionId,
      audienceQuestionVersion: opts?.audienceQuestionVersion,
      audienceQuestionGenerationKey: opts?.audienceQuestionGenerationKey,
      monthlyCampaignId: opts?.monthlyCampaignId ?? monthly?.campaignId,
      monthlyPlanId: opts?.monthlyPlanId ?? monthly?.planId,
      monthlyItemId: opts?.monthlyItemId ?? monthly?.itemId,
      suggestMedia: opts?.suggestMedia,
    };
    const aiId = uid("m");

    genRef.current.set(aiId, gen);
    setMessages((prev) => [
      ...prev,
      { id: uid("m"), role: "user", text },
      {
        id: aiId,
        role: "ai",
        text: "",
        progressLabel: "Начинаю писать — текст появится сразу…",
        streaming: true,
        postable: false,
      },
    ]);
    setDraft("");
    setPendingLibraryReference(null);
    setContextDraft(null);
    void startStream(aiId, gen);
  };

  // «Создать публикацию» — это явное согласие на одну генерацию. Intent остаётся в URL
  // до серверного сохранения результата: refresh повторит тот же idempotency key,
  // восстановит staged result и не оставит пользователя с пустым экраном.
  useEffect(() => {
    const pending = pendingReferenceGeneration;
    if (
      !pending
      || !postSettingsReady
      || enginesLoading
      || contextDraft?.id !== pending.draftId
      || !pendingLibraryReference
      || startedReferenceDraftsRef.current.has(pending.draftId)
    ) return;

    startedReferenceDraftsRef.current.add(pending.draftId);
    setPendingReferenceGeneration(null);
    ask(pending.prompt, {
      cmd: "write",
      input: pending.prompt,
      skipBrief: true,
      requestKey: pending.requestKey,
      autoOpenComposer: true,
      referenceDraftId: pending.draftId,
      referenceDraftVersion: pending.version,
      resultClientKey: pending.resultClientKey,
      channelId: pending.channelId,
      postSettings: pending.variant
        ? legalOpportunityPostSettings(postSettings, pending.variant, pending.network)
        : undefined,
      suggestMedia: pending.suggestMedia,
    });
    // `ask` intentionally consumes the reference/context captured by this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextDraft, enginesLoading, pendingLibraryReference, pendingReferenceGeneration, postSettingsReady]);

  useEffect(() => {
    const pending = pendingAudienceQuestionGeneration;
    const identity = pending ? `${pending.questionId}:${pending.questionVersion}` : "";
    if (
      !pending
      || !postSettingsReady
      || enginesLoading
      || !channelId
      || startedAudienceQuestionsRef.current.has(identity)
    ) return;
    startedAudienceQuestionsRef.current.add(identity);
    setPendingAudienceQuestionGeneration(null);
    ask(pending.prompt, {
      cmd: "write",
      input: pending.prompt,
      skipBrief: true,
      requestKey: pending.requestKey,
      autoOpenComposer: true,
      resultClientKey: pending.resultClientKey,
      audienceQuestionId: pending.questionId,
      audienceQuestionVersion: pending.questionVersion,
      audienceQuestionGenerationKey: pending.requestKey,
      channelId,
    });
    // `ask` intentionally captures the selected channel and current post settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, enginesLoading, pendingAudienceQuestionGeneration, postSettingsReady]);

  const stop = () => {
    const stopped = abortStudioStream(streamRef.current);
    if (!stopped) return;
    setMessages(stopStudioStreamingMessages);
  };

  const regenerate = (id: string) => {
    if (streamRef.current.current) return;
    const gen = genRef.current.get(id);
    if (!gen) return;
    if (aiUsage?.exhausted) {
      limitToast();
      return;
    }

    const next: Gen = { ...gen, variant: gen.variant + 1, requestKey: crypto.randomUUID() };
    genRef.current.set(id, next);
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id
          ? {
              ...m,
              progressLabel: "Готовлю новый вариант — предыдущий текст остаётся на месте…",
              streaming: true,
              postable: false,
              reviewable: false,
              requiresReview: false,
              errorMessage: undefined,
              statusMessage: undefined,
              interrupted: false,
              retryable: false,
              quality: undefined,
              aiValidation: undefined,
              requestId: undefined,
              requestedEngine: undefined,
              effectiveEngine: undefined,
              fallbackUsed: false,
              replayed: false,
            }
          : m,
      ),
    );
    void startStream(id, next);
  };

  const retryGeneration = (id: string) => {
    if (streamRef.current.current) return;
    const gen = genRef.current.get(id);
    if (!gen) return;
    if (aiUsage?.exhausted) {
      limitToast();
      return;
    }
    setMessages((prev) => prev.map((message) => message.id === id ? {
      ...message,
      streaming: true,
      progressLabel: "Повторяю тот же запрос — сохранённый текст остаётся на месте…",
      postable: false,
      reviewable: false,
      requiresReview: false,
      errorMessage: undefined,
      statusMessage: undefined,
      interrupted: false,
      retryable: false,
      quality: undefined,
      aiValidation: undefined,
      requestId: undefined,
      requestedEngine: undefined,
      effectiveEngine: undefined,
      fallbackUsed: false,
      replayed: false,
    } : message));
    void startStream(id, gen);
  };

  const improve = () => {
    ask("Улучшить последний текст", {
      cmd: "rewrite",
      input: "Отредактируй последний ответ: сделай текст яснее, сильнее и естественнее. Сохрани смысл, подтверждённые факты и требования выбранной площадки.",
      skipBrief: true,
      postSettings: normalizePostSettings({
        ...postSettings,
        qualityMode: "maximum",
        autoImprove: true,
      }),
    });
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      s.toast({ kind: "info", title: "Скопировано", body: "Текст в буфере обмена." });
    } catch {
      s.toast({
        kind: "danger",
        title: "Не получилось скопировать",
        body: "Браузер не дал доступ к буферу обмена. Выдели текст и скопируй вручную — он никуда не денется.",
      });
    }
  };

  const putInComposer = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const onQuick = (q: Quick) => {
    if (busy) return;

    if (q.mediaKind) {
      setMediaKind(q.mediaKind);
      setWorkspaceMode("studio");
      return;
    }

    if (q.id === "rewrite-last") {
      const last = [...messages]
        .reverse()
        .find((m) => m.role === "ai" && m.postable && m.text.trim().length > 0);

      if (!last) {
        s.toast({
          kind: "info",
          title: "Пока нечего переписывать",
          body: "Сначала попроси ИИ что-нибудь написать — а потом перепишем в один клик.",
        });
        return;
      }
      ask("Перепиши последнее", { cmd: "rewrite", input: last.text });
      return;
    }

    if (q.instant) {
      ask(q.instant);
      return;
    }

    if (q.draft) {
      putInComposer(q.draft);
    }
  };

  const useGeneratedMedia = (generation: MediaGeneration) => {
    if (!generation.assetId || !generation.assetUrl) return;
    sessionStorage.setItem(
      "aurora:generated-media",
      JSON.stringify({
        kind: generation.kind,
        label: generation.kind === "video" ? `Рилс ${generation.seconds ?? 6} сек.` : `Изображение ${generation.aspectRatio}`,
        hue: generation.kind === "video" ? 42 : 48,
        assetId: generation.assetId,
        url: generation.assetUrl,
        mimeType: generation.mimeType,
      }),
    );
    router.push("/app/composer?fromMedia=1&from=studio");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    ask(draft);
  };

  /* ---------------------------------------------------------- РАБОЧАЯ ЗОНА */

  const selectedNetwork = activeChannels.find((channel) => channel.id === channelId)?.network;
  const briefConflicts = validatePostSettingsConflicts(postSettings);
  const briefBlockers = briefConflicts.filter((item) => item.severity === "error");
  const briefSummary = buildPostSettingsSummary(postSettings, selectedNetwork);
  const latestAiStatus = [...messages]
    .reverse()
    .find((message) => message.role === "ai");
  const generationAnnouncement = latestAiStatus?.streaming
    ? latestAiStatus.progressLabel ?? "Генерация продолжается"
    : latestAiStatus?.statusMessage ?? (latestAiStatus?.reviewable ? "Черновик готов." : "");
  const originalityLimit = postSettings.originalityDepth === "all" ? 200 : Number(postSettings.originalityDepth);
  const similarPosts = pendingBrief && postSettings.showSimilarPosts
    ? s.realPosts
        .filter((post) => post.channel_id === channelId && post.status === "published" && post.text.trim())
        .slice(0, originalityLimit)
        .map((post) => ({ post, score: lexicalSimilarity(`${pendingBrief.text} ${postSettings.mainIdea}`, post.text) }))
        .filter((item) => item.score >= 0.16)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
    : [];

  return (
    <AppShell
      title="Студия контента"
      action={contextDraft ? <EvidenceCard kind="draft" id={contextDraft.id} label="Доказательства источника" compact /> : undefined}
      subtitle={
        workspaceMode === "chat"
          ? "Обсуждай идеи и создавай тексты в обычном диалоге."
          : "Опиши идею словами — Аврора создаст визуал прямо в диалоге."
      }
    >
      {!s.ready || !s.authReady || !sessionOwner || chatSessionOwner !== sessionOwner ? (
        <StudioSkeleton />
      ) : (
        <>
          {/* Stable live region: updates are announced reliably without reading every token. */}
          <div role="status" className="sr-only">
            {generationAnnouncement}
          </div>
          {/* Чат и Студия остаются смонтированы: можно переключаться
              между ними, не теряя черновик сообщения или настройки генерации медиа. */}
          <div
            id="chat-workspace"
            aria-label="Режим Чат"
            ref={attachShell}
            className={cn(
              "mx-auto h-[var(--studio-h)] w-full max-w-[1180px]",
              workspaceMode === "chat" ? "flex" : "hidden",
            )}
          >
            {/* min-h-0 обязателен: лента сжимается и прокручивается внутри, а поле ввода
                остаётся закреплённым внизу рабочей области. */}
            <section aria-label="Диалог с ИИ" className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Одна прокрутка для всей истории; сам текст держим в комфортной ширине. */}
              <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto">
                <div
                  className={cn(
                    "mx-auto flex min-h-full w-full max-w-[820px] flex-col px-4 py-6 md:px-6 md:py-8",
                    messages.length > 0 ? "gap-7" : "justify-center",
                  )}
                >
                  {messages.map((message) => (
                    <MessageRow
                      key={message.id}
                      msg={message}
                      reduce={reduce}
                      onStop={stop}
                      onSchedule={() => openAsPost(message.id, primaryPublication(message.text))}
                      onCopy={() => void copy(message.text)}
                      onRegenerate={() => regenerate(message.id)}
                      onRetry={() => retryGeneration(message.id)}
                      onImprove={improve}
                      onShorten={() => ask("Сделай короче")}
                      creatingPost={creatingPostId === message.id}
                    />
                  ))}

                  {messages.length === 0 && (
                    <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center">
                      <h2 className="text-[22px] font-semibold tracking-tight text-text-2">
                        Чем помочь?
                      </h2>
                      <p className="mt-2 text-[14px] text-text-3">
                        Напиши задачу — ответ появится здесь.
                      </p>
                    </div>
                  )}

                  <div ref={endRef} className="h-px shrink-0" aria-hidden />
                </div>
              </div>

              {/* Единый composer: текст сверху, все вторичные действия — в одной строке снизу. */}
              <div className="shrink-0 px-3 pb-3 md:px-5 md:pb-4">
                <div className="mx-auto w-full max-w-[820px] rounded-[24px] border border-line/70 bg-surface shadow-[0_12px_40px_rgb(17_17_17/0.10)] transition-shadow focus-within:shadow-[0_14px_44px_rgb(17_17_17/0.14)] focus-within:ring-2 focus-within:ring-brand/15">
                  {engineStatusError && (
                    <div role="alert" className="border-b border-danger-text/20 bg-danger-soft px-4 py-2.5 text-[11px] text-danger-text">
                      {engineStatusError}
                    </div>
                  )}
                  {pendingBrief && (
                    <div className="border-b border-line px-4 py-3.5">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-[12px] font-extrabold text-text">Нужно уточнение</p>
                          <p className="mt-1 text-[11px] leading-relaxed text-text-2">{briefSummary}</p>
                        </div>
                        <button type="button" onClick={() => setPendingBrief(null)} className="shrink-0 text-[11px] font-bold text-text-3 hover:text-text">Закрыть</button>
                      </div>
                      {briefConflicts.length > 0 && (
                        <div className={cn("mt-2.5 rounded-sm px-3 py-2 text-[10px] leading-relaxed", briefBlockers.length ? "bg-danger-soft text-danger-text" : "bg-info-soft text-info-text") }>
                          {briefConflicts.map((item) => <p key={item.code}>• {item.message}</p>)}
                        </div>
                      )}
                      {postSettings.showSimilarPosts && (
                        <div className="mt-2.5 rounded-sm bg-surface-inset px-3 py-2 text-[10px] leading-relaxed text-text-3">
                          <p className="font-bold text-text-2">Похожие старые публикации</p>
                          {similarPosts.length ? similarPosts.map(({ post, score }) => (
                            <p key={post.id} className="mt-1">• {Math.round(score * 100)}% · {post.text.slice(0, 120)}{post.text.length > 120 ? "…" : ""}</p>
                          )) : <p className="mt-1">Заметных смысловых повторов не найдено.</p>}
                        </div>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" variant="brand" disabled={briefBlockers.length > 0} onClick={() => ask(pendingBrief.text, { ...pendingBrief.opts, skipBrief: true })}>Продолжить</Button>
                        <Button size="sm" variant="ghost" onClick={() => {
                          setPendingBrief(null);
                          router.push(`/app/settings${channelId ? `?channel=${channelId}` : ""}`);
                        }}>Открыть настройки Авроры</Button>
                      </div>
                    </div>
                  )}
                  {pendingLibraryReference && !pendingBrief && (
                    <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-[11px]">
                      <p className="min-w-0 truncate text-text-2">
                        <span className="font-extrabold text-text">Референс подключён</span>
                        {pendingLibraryReference.source ? ` · ${pendingLibraryReference.source}` : ""}
                        <span className="ml-1 text-text-3">— беру только механику, не факты</span>
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setPendingLibraryReference(null);
                          setContextDraft(null);
                        }}
                        className="shrink-0 font-bold text-text-3 hover:text-text"
                      >
                        Убрать
                      </button>
                    </div>
                  )}
                  {pendingEngineSuggestion && !pendingBrief && (
                    <div role="status" className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 text-[11px]">
                      <p className="text-text-2">
                        <span className="font-extrabold text-text">Готова модель {pendingEngineSuggestion.label}.</span>{" "}
                        Текущий выбор не изменится без подтверждения.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="soft"
                        className="shrink-0"
                        onClick={() => void pickEngine(pendingEngineSuggestion)}
                      >
                        Переключиться на {pendingEngineSuggestion.label}
                      </Button>
                    </div>
                  )}
                  <Textarea
                    ref={inputRef}
                    data-chat-composer
                    rows={1}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={onKeyDown}
                    aria-label="Что написать ИИ"
                    placeholder="Напиши сообщение Авроре…"
                    className="min-h-[64px] max-h-[180px] overflow-y-auto rounded-t-[24px] border-0 bg-transparent px-5 pt-4 pb-2 text-[16px] leading-relaxed hover:border-0 focus:border-0 focus-visible:ring-0"
                  />

                  <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1.5 px-3 pb-3">
                    <QuickActionsMenu items={QUICK} onPick={onQuick} disabled={busy} />
                    <PostSettingsMenu
                      value={postSettings}
                      onChange={(next) => void savePostSettings(next)}
                      network={selectedNetwork}
                      disabled={busy || !postSettingsReady}
                      saving={postSettingsSaving}
                    />
                    <ChannelMenu
                      channels={activeChannels}
                      value={channelId}
                      onChange={setPickedChannelId}
                      disabled={busy}
                    />
                    <ModelMenu
                      engines={engines}
                      current={engine}
                      onPick={pickEngine}
                      loading={enginesLoading}
                      disabled={busy}
                    />

                    <Button
                      variant="brand"
                      size="icon"
                      className="ml-auto shrink-0 rounded-full"
                      aria-label="Отправить"
                      disabled={busy || (draft.trim().length === 0 && postSettings.mainIdea.trim().length === 0)}
                      onClick={() => ask(draft)}
                    >
                      <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
                    </Button>
                  </div>
                  <p
                    role="status"
                    aria-live="polite"
                    className={cn(
                      "px-5 pb-3 text-[12px] leading-relaxed",
                      chatPersistenceStatus === "local" ? "text-danger-text" : "text-text-3",
                    )}
                  >
                    {persistenceLabel}
                  </p>
                </div>
              </div>
            </section>
          </div>

          <div
            id="studio-workspace"
            aria-label="Режим Картинки и видео"
            ref={attachDesignShell}
            className={cn(
              "mx-auto w-full max-w-[1180px]",
              workspaceMode === "studio" ? "block" : "hidden",
            )}
          >
            <MediaGenerator
              key={mediaKind}
              initialKind={mediaKind}
              channelId={channelId}
              sourceText={primaryPublication([...messages].reverse().find((message) => message.role === "ai" && message.postable)?.text ?? "")}
              onUse={useGeneratedMedia}
            />
          </div>
        </>
      )}
    </AppShell>
  );
}

/**
 * useSearchParams() «выключает» пререндер всего дерева до ближайшей границы Suspense,
 * и next build падает, если её нет (в dev проверки нет — потому и не видели). Оборачиваем,
 * как велит документация этой версии Next: показываем тот же скелет, что и при загрузке.
 */
export default function StudioPage() {
  return (
    <Suspense
      fallback={
        <AppShell
          title="Студия контента"
          subtitle="Создавай, улучшай и адаптируй публикации вместе с Авророй."
        >
          <StudioSkeleton />
        </AppShell>
      }
    >
      <StudioPageInner />
    </Suspense>
  );
}
