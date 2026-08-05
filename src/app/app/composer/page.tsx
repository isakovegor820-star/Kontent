"use client";

// А5. Редактор поста (Приложение А). Главное действие — «Запланировать».
// ТЗ 5.3: один пост адаптируется под обе сети с предпросмотром — предпросмотры
// TG и VK живут справа и обновляются на каждый символ.
// ТЗ 5.6: ИИ пишет/переписывает/сокращает с опорой на разведку (sourceRef → тренд/конкурент).
//
// Next 16: страница читает ?draft=, ?date=, ?time= через useSearchParams(), а он требует
// обёртки в <Suspense> — иначе билд падает на CSR bailout. Поэтому всё состояние формы
// живёт в ComposerPage (над Suspense), чтобы кнопка «Запланировать» в шапке AppShell
// видела то же состояние, что и редактор. ComposerInner только читает параметры и рисует.

import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Bookmark,
  CalendarClock,
  CircleStop,
  Clapperboard,
  Clock,
  Eye,
  Flame,
  Heart,
  ImageIcon,
  MessageCircle,
  RefreshCw,
  Scissors,
  Share2,
  Sparkles,
  Trash2,
  TrendingUp,
  Video,
  X,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import {
  Badge,
  Card,
  Checkbox,
  Divider,
  EmptyState,
  Field,
  Input,
  TelegramIcon,
  Textarea,
  VkIcon,
} from "@/components/ui/primitives";
import { parseAiStreamBuffer, type AiStreamEvent } from "@/lib/ai-stream";
import {
  aiDraftPhaseLabel,
  createAiDraftProjection,
  projectAiDraftEvent,
  type AiDraftPhase,
} from "@/lib/ai-draft-projection";
import {
  acknowledgeAiTerminal,
  stableAiClientRequest,
  type AiClientRequestIdentity,
} from "@/lib/ai-client-idempotency";
import { getAiUsageMetrics } from "@/lib/ai-usage-sync";
import { composerHydrationIdentity } from "@/lib/app-routes";
import {
  activeComposerNetworks,
  attestServerDraftReview,
  createDraftClientKey,
  createServerDraft,
  deleteServerDraft,
  DRAFT_AUTOSAVE_DELAY_MS,
  draftMatchesWrite,
  DraftRequestError,
  getServerDraft,
  isRecoverableLegacyDraft,
  runSingleDraftSave,
  reusableAcknowledgedDraft,
  scheduleDraftAutosave,
  shouldAutosaveDraft,
  updateServerDraft,
} from "@/lib/draft-client";
import type { DraftAiValidation, DraftSaveState, ServerDraft } from "@/lib/draft-types";
import {
  acknowledgePendingDraft,
  findPendingDraft,
  listPendingDrafts,
  persistPendingDraft,
  removePendingDraft,
  type PendingDraftRevision,
} from "@/lib/draft-outbox";
import { composerAiReviewState } from "@/lib/draft-review";
import {
  nextMoscowPublishingSlot,
  type BestPublishingTime,
} from "@/lib/best-publishing-time";
import { useStore } from "@/lib/store";
import type { Network, Post, RealChannel } from "@/lib/types";
import {
  addDays,
  atTime,
  cn,
  fmtCompact,
  fmtDate,
  fmtDateTime,
  fmtNum,
  fmtTime,
  plural,
} from "@/lib/utils";

/* ------------------------------------------------------------------ ХЕЛПЕРЫ */

/** Лимиты сетей на текст сообщения. Предпросмотр TG честно режет до своего.
 * Композитор пока умеет только в текстовые сети (tg/vk); у медиа-сетей (youtube/instagram/...)
 * лимит другой, поэтому здесь Partial — не требуем ключи всех сетей. */
const TG_LIMIT = 4096;
const VK_LIMIT = 16384;
const NETWORK_LIMIT: Partial<Record<Network, number>> = { tg: TG_LIMIT, vk: VK_LIMIT };

const NETWORK_ORDER: Network[] = ["tg", "vk"];

const toDateValue = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const toTimeValue = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** «2026-07-15» + «10:00» → Date в местном времени. null — если пусто или мусор. */
function parseWhen(date: string, time: string): Date | null {
  if (!date || !time) return null;
  const d = new Date(`${date}T${time}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Заглушка медиа: цветной градиент по hue — файлы в демо не грузим. */
const mediaStyle = (hue: number) => ({
  backgroundImage: `linear-gradient(135deg, hsl(${hue} 88% 64%), hsl(${(hue + 46) % 360} 82% 48%))`,
});

const chars = (n: number) => `${fmtNum(n)} ${plural(n, "символ", "символа", "символов")}`;

function draftToPost(draft: ServerDraft): Post {
  const networks = NETWORK_ORDER.filter((network) =>
    draft.destinations.some((destination) => destination.network === network),
  );
  return {
    id: `draft-${draft.id}`,
    text: draft.text,
    networks,
    scheduledAt: draft.scheduled_at,
    status: "draft",
    origin: draft.origin,
    sourceRef: draft.source_ref ?? undefined,
    media: draft.media,
    createdAt: draft.created_at,
  };
}

/* ------------------------------------------------------------- ОБЩЕЕ СОСТОЯНИЕ */

type Errors = { text?: string; networks?: string; when?: string };
type ComposerAiCommand = "write" | "rewrite" | "shorten" | "script";
type AiReviewState = "none" | "required" | "blocked";
type DraftPersistMode = "manual" | "autosave" | "schedule";
type ComposerAiPreview = {
  text: string;
  phase: AiDraftPhase | null;
  status: "running" | "interrupted";
  requestId?: string;
};

interface HydrateInput {
  ownerUserId: number | null;
  post: Post | null;
  draft?: ServerDraft | null;
  pending?: PendingDraftRevision | null;
  pendingConflict?: boolean;
  date: string | null;
  time: string | null;
  media?: Post["media"];
  defaultNetworks?: Network[];
}

interface ComposerValue {
  hydrated: boolean;
  editingId: string | null;
  draftId: number | null;
  text: string;
  setText: (v: string) => void;
  networks: Network[];
  setNetworks: (value: Network[]) => void;
  toggleNetwork: (n: Network, on: boolean) => void;
  /** Активные Telegram-каналы аккаунта. Пусто — канал ещё не подключён. */
  tgChannels: RealChannel[];
  /** Активные VK-сообщества аккаунта. Пусто — сообщество ещё не подключено. */
  vkChannels: RealChannel[];
  /** В какой TG-канал уходит пост. null — каналов нет или ещё грузятся. */
  channelId: number | null;
  setChannelId: (id: number) => void;
  /** В какое VK-сообщество уходит пост. null — сообществ нет или ещё грузятся. */
  vkChannelId: number | null;
  setVkChannelId: (id: number) => void;
  media: Post["media"];
  setMedia: (m: Post["media"]) => void;
  sourceRef: Post["sourceRef"];
  date: string;
  setDate: (v: string) => void;
  time: string;
  setTime: (v: string) => void;
  noDate: boolean;
  setNoDate: (v: boolean) => void;
  aiBusy: ComposerAiCommand | null;
  typing: boolean;
  aiPreview: ComposerAiPreview | null;
  applyAiPreview: () => void;
  dismissAiPreview: () => void;
  aiReview: AiReviewState;
  confirmAiReview: () => void;
  topicOpen: boolean;
  setTopicOpen: (v: boolean) => void;
  topic: string;
  setTopic: (v: string) => void;
  errors: Errors;
  confirmDelete: boolean;
  setConfirmDelete: (v: boolean) => void;
  draftSaveState: DraftSaveState;
  draftSavedAt: string | null;
  bestTime: BestPublishingTime | null;
  saving: boolean;
  runAi: (cmd: ComposerAiCommand) => void;
  stopAi: () => void;
  quick: (kind: "hour" | "tomorrow" | "best") => void;
  schedule: () => void;
  saveDraft: () => Promise<void>;
  removeCurrent: () => Promise<void>;
  hydrate: (input: HydrateInput) => void;
}

const ComposerCtx = createContext<ComposerValue | null>(null);

function useComposer() {
  const v = useContext(ComposerCtx);
  if (!v) throw new Error("useComposer должен вызываться внутри редактора поста");
  return v;
}

/* ---------------------------------------------------------------- СТРАНИЦА */

export default function ComposerPage() {
  const s = useStore();
  const router = useRouter();
  const composerUserId = s.user?.id ?? null;

  const [hydrated, setHydrated] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<number | null>(null);
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [legacyId, setLegacyId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [networks, setNetworks] = useState<Network[]>([]);
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [pickedVkId, setPickedVkId] = useState<number | null>(null);
  const [media, setMedia] = useState<Post["media"]>(null);
  const [sourceRef, setSourceRef] = useState<Post["sourceRef"]>(undefined);
  const [origin, setOrigin] = useState<Post["origin"]>("manual");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [noDate, setNoDate] = useState(false);
  const [aiBusy, setAiBusy] = useState<ComposerAiCommand | null>(null);
  const [typing, setTyping] = useState(false);
  const [aiPreview, setAiPreview] = useState<ComposerAiPreview | null>(null);
  const [aiReview, setAiReview] = useState<AiReviewState>("none");
  const [aiValidation, setAiValidation] = useState<DraftAiValidation | null>(null);
  const [topicOpen, setTopicOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>("idle");
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [lastSavedRevision, setLastSavedRevision] = useState(0);
  const [lastAttemptedRevision, setLastAttemptedRevision] = useState(0);
  const [bestTimeResult, setBestTimeResult] = useState<
    (BestPublishingTime & { channelId: number }) | null
  >(null);

  const cancelRef = useRef<(() => void) | null>(null);
  const aiRequestRef = useRef<AiClientRequestIdentity | null>(null);
  const draftClientKeyRef = useRef<string | null>(null);
  const draftRequestRef = useRef<Promise<ServerDraft | null> | null>(null);
  const acknowledgedDraftRef = useRef<ServerDraft | null>(null);
  const scheduleRequestRef = useRef(false);
  const publicationOperationRef = useRef<{ key: string; fingerprint: string | null } | null>(null);
  const reviewRequestRef = useRef(false);
  const draftRevisionRef = useRef(0);
  const lastSavedRevisionRef = useRef(0);
  const lastAttemptedRevisionRef = useRef(0);
  const hydratedUserIdRef = useRef<number | null>(null);

  const markDraftDirty = useCallback(() => {
    draftRevisionRef.current += 1;
    setDraftRevision(draftRevisionRef.current);
    setDraftSaveState((state) => {
      if (state === "offline" || state === "conflict") return state;
      return "pending";
    });
    setDraftSavedAt(null);
  }, []);

  // Уходим со страницы — гасим печать ИИ, чтобы не сыпать setState в пустоту
  useEffect(
    () => () => {
      cancelRef.current?.();
    },
    [],
  );

  /** Первичное заполнение формы: пост из ?id= либо чистый лист на ?date=/?time= */
  const hydrate = useCallback(({
    post,
    draft,
    pending,
    pendingConflict = false,
    date: d,
    time: t,
    media: generatedMedia,
    defaultNetworks,
    ownerUserId,
  }: HydrateInput) => {
    const fallback = new Date(Date.now() + 3600_000);
    fallback.setMinutes(0, 0, 0); // ровный час — по нему легче попадать глазом
    const when = post?.scheduledAt ? new Date(post.scheduledAt) : fallback;

    setEditingId(post?.id ?? null);
    setDraftId(draft?.id ?? pending?.draftId ?? null);
    setDraftVersion(draft?.version ?? pending?.baseVersion ?? null);
    setLegacyId(post && !draft ? post.id : null);
    draftRevisionRef.current = pending?.revision ?? 0;
    lastSavedRevisionRef.current = 0;
    lastAttemptedRevisionRef.current = 0;
    setDraftRevision(pending?.revision ?? 0);
    setLastSavedRevision(0);
    setLastAttemptedRevision(0);
    draftClientKeyRef.current = pending?.clientKey ?? draft?.client_key ?? null;
    acknowledgedDraftRef.current = draft ?? null;
    hydratedUserIdRef.current = ownerUserId;
    const pendingTgId = pending?.form.channelIds.find((id) =>
      pending.form.networks.includes("tg") && defaultNetworks?.includes("tg") && id > 0,
    );
    const pendingVkId = pending?.form.channelIds.find((id) =>
      pending.form.networks.includes("vk") && id !== pendingTgId && id > 0,
    );
    setPickedId(pendingTgId ?? draft?.destinations.find((destination) => destination.network === "tg")?.channel_id ?? null);
    setPickedVkId(pendingVkId ?? draft?.destinations.find((destination) => destination.network === "vk")?.channel_id ?? null);
    setText(pending?.payload.text ?? post?.text ?? "");
    setNetworks(pending?.form.networks ?? (post?.networks?.length ? post.networks : (defaultNetworks ?? [])));
    setMedia(generatedMedia ?? pending?.payload.media ?? post?.media ?? null);
    setSourceRef(pending?.payload.sourceRef ?? post?.sourceRef);
    setOrigin(pending?.payload.origin ?? post?.origin ?? "manual");
    setAiPreview(null);
    setAiValidation(pending?.payload.aiValidation ?? draft?.ai_validation ?? null);
    // Validation and a human ACK are server-owned and versioned. Reload/another tab gets
    // the exact persisted state; a legacy AI draft without it remains review-required.
    setAiReview(
      pending
        ? pending.payload.origin === "ai"
          ? "required"
          : "none"
        : draft
        ? composerAiReviewState(draft)
        : post?.origin === "ai"
          ? "required"
          : "none",
    );
    setDate(pending?.form.date ?? d ?? toDateValue(when));
    setTime(pending?.form.time ?? t ?? toTimeValue(when));
    // Клик по дню в календаре — это явное намерение поставить дату
    setNoDate(pending?.form.noDate ?? (d ? false : post ? post.scheduledAt === null : false));
    setDraftSaveState(pending ? (pendingConflict ? "conflict" : "pending") : draft ? "saved" : "idle");
    setDraftSavedAt(pending ? null : draft?.updated_at ?? null);
    setHydrated(true);
  }, []);

  /* -------------------------------------------------------------- КАНАЛЫ */
  // Каналов может быть несколько (мультиканальность).
  const tgChannels = useMemo(
    () => s.realChannels.filter((c) => c.network === "tg" && c.is_active),
    [s.realChannels],
  );
  const vkChannels = useMemo(
    () => s.realChannels.filter((c) => c.network === "vk" && c.is_active),
    [s.realChannels],
  );

  // Выбранный канал ВЫЧИСЛЯЕМ, а не синхронизируем эффектом. Каналы приезжают асинхронно,
  // и выбранный мог быть отключён в другой вкладке — при вычислении оба случая
  // разруливаются сами: нет живого выбора → первый активный. Плюс никакого setState
  // в эффекте, за который справедливо ругается линтер.
  const channelId = useMemo(() => {
    if (pickedId != null) return tgChannels.some((c) => c.id === pickedId) ? pickedId : null;
    return tgChannels[0]?.id ?? null;
  }, [pickedId, tgChannels]);
  const vkChannelId = useMemo(() => {
    if (pickedVkId != null) return vkChannels.some((c) => c.id === pickedVkId) ? pickedVkId : null;
    return vkChannels[0]?.id ?? null;
  }, [pickedVkId, vkChannels]);
  const bestTime = bestTimeResult?.channelId === channelId ? bestTimeResult : null;

  useEffect(() => {
    if (!channelId) return;
    const controller = new AbortController();
    fetch(`/api/stats?channel=${channelId}`, { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { bestTime?: BestPublishingTime | null } | null) => {
        if (body?.bestTime) setBestTimeResult({ ...body.bestTime, channelId });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [channelId]);

  const toggleNetwork = useCallback(
    (n: Network, on: boolean) => {
      const next = NETWORK_ORDER.filter((x) => (x === n ? on : networks.includes(x)));
      setNetworks(next);
      markDraftDirty();
      setErrors((e) => ({
        ...e,
        networks: next.length ? undefined : "Выбери хотя бы одну сеть — иначе посту некуда идти.",
      }));
    },
    [markDraftDirty, networks],
  );

  const changeText = useCallback((value: string) => {
    setText(value);
    if (origin === "ai") {
      setAiValidation(null);
      setAiReview("required");
    }
    markDraftDirty();
  }, [markDraftDirty, origin]);
  const changeNetworks = useCallback((value: Network[]) => {
    setNetworks(value);
    markDraftDirty();
  }, [markDraftDirty]);
  const changeChannelId = useCallback((value: number) => {
    setPickedId(value);
    markDraftDirty();
  }, [markDraftDirty]);
  const changeVkChannelId = useCallback((value: number) => {
    setPickedVkId(value);
    markDraftDirty();
  }, [markDraftDirty]);
  const changeMedia = useCallback((value: Post["media"]) => {
    setMedia(value);
    markDraftDirty();
  }, [markDraftDirty]);
  const changeDate = useCallback((value: string) => {
    setDate(value);
    markDraftDirty();
  }, [markDraftDirty]);
  const changeTime = useCallback((value: string) => {
    setTime(value);
    markDraftDirty();
  }, [markDraftDirty]);
  const changeNoDate = useCallback((value: boolean) => {
    setNoDate(value);
    markDraftDirty();
  }, [markDraftDirty]);

  /* --------------------------------------------------------------------- ИИ */

  const stopAi = useCallback(() => {
    cancelRef.current?.();
  }, []);

  const runAi = useCallback(
    async (cmd: ComposerAiCommand) => {
      if (typing || cancelRef.current) return;

      const hasText = text.trim().length > 0;
      const hasTopic = topic.trim().length > 0;

      // «Напиши»/«Сценарий» на пустом листе — сначала спросим тему
      if ((cmd === "write" || cmd === "script") && !hasText && !hasTopic) {
        setTopicOpen(true);
        return;
      }
      if ((cmd === "rewrite" || cmd === "shorten") && !hasText) {
        s.toast({
          kind: "info",
          title: "Сначала нужен текст",
          body: "Перепишу и сокращу то, что уже написано. Пустой лист — жми «Напиши».",
        });
        return;
      }

      // Это только ранняя подсказка. Атомарный reserve/commit/release всегда делает сервер.
      const usage = getAiUsageMetrics(s.aiUsageStatus, s.aiUsed, s.aiLimit);
      if (usage?.exhausted) {
        s.toast({
          kind: "danger",
          title: "Лимит ИИ на сегодня исчерпан",
          body: `Использовано ${usage.used} из ${usage.limit}. Лимит обновится завтра.`,
        });
        return;
      }

      setErrors((e) => ({ ...e, text: undefined }));
      setAiBusy(cmd);
      setTyping(true);
      setAiPreview(null);

      const subject = topic.trim() || text.trim();
      const source = cmd === "rewrite" || cmd === "shorten" ? text : subject;
      const contextChannelId = networks.includes("tg")
        ? channelId
        : networks.includes("vk")
          ? vkChannelId
          : null;
      const originalText = text;
      const controller = new AbortController();
      const cancelCurrent = () => controller.abort();
      cancelRef.current = cancelCurrent;
      let projection = createAiDraftProjection(originalText);
      let buffer = "";
      const streamState: {
        validation: AiReviewState;
        payload: DraftAiValidation | null;
      } = { validation: "required", payload: null };
      let failed = false;
      let doneReceived = false;
      let validationReceived = false;
      let requestId: string | undefined;

      const updatePreview = (status: ComposerAiPreview["status"] = "running") => {
        const candidate = projection.visibleText;
        if (!candidate.trim() || candidate === originalText) return;
        setAiPreview({
          text: candidate,
          phase: projection.phase,
          status,
          requestId,
        });
      };

      const applyEvent = (event: AiStreamEvent) => {
        requestId = event.requestId;
        if (event.type === "phase") {
          projection = projectAiDraftEvent(projection, event);
          updatePreview();
        } else if (event.type === "delta") {
          projection = projectAiDraftEvent(projection, event);
          updatePreview();
        } else if (event.type === "replace") {
          projection = projectAiDraftEvent(projection, event);
          updatePreview();
        } else if (event.type === "validation") {
          validationReceived = true;
          streamState.payload = {
            version: 1,
            status: event.status,
            requiresReview: event.requiresReview,
            provenance: event.provenance,
            blockerCodes: event.blockerCodes,
          };
          streamState.validation = event.status === "passed"
            ? "none"
            : event.status === "blocked"
              ? "blocked"
              : "required";
        } else if (event.type === "error") {
          failed = true;
          updatePreview("interrupted");
          s.toast({
            kind: "danger",
            title: "ИИ не закончил текст",
            body: event.retryable
              ? `Связь с моделью прервалась. Исходный текст и ключ запроса сохранены — можно повторить.${requestId ? ` Номер запроса: ${requestId}` : ""}`
              : `Результат не прошёл проверку. Уточни задание или открой ИИ-студию.${requestId ? ` Номер запроса: ${requestId}` : ""}`,
          });
        } else if (event.type === "done") {
          projection = projectAiDraftEvent(projection, event);
          updatePreview();
          doneReceived = true;
        }
      };

      try {
        const requestBody = JSON.stringify({
          command: cmd,
          input: source,
          surface: "composer",
          channelId: contextChannelId,
        });
        const aiRequest = stableAiClientRequest(aiRequestRef.current, requestBody);
        aiRequestRef.current = aiRequest;
        const response = await fetch("/api/ai/generate", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": aiRequest.key,
          },
          signal: controller.signal,
          body: requestBody,
        });
        requestId = response.headers.get("x-ai-request-id") ?? undefined;
        if (!response.ok || !response.body) {
          const info = (await response.json().catch(() => null)) as { error?: string; requestId?: string } | null;
          requestId = info?.requestId ?? requestId;
          const message = response.status === 429
            ? "Дневной лимит исчерпан. Счётчик обновлён с сервера."
            : info?.error === "brief_insufficient_facts"
              ? "Для безопасного текста не хватает фактов. Добавь детали в бриф."
              : "Генерация сейчас недоступна. Исходный текст не изменён.";
          s.toast({
            kind: "danger",
            title: "Не получилось",
            body: `${message}${requestId ? ` Номер запроса: ${requestId}` : ""}`,
          });
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseAiStreamBuffer(buffer);
          buffer = parsed.rest;
          parsed.events.forEach(applyEvent);
        }
        buffer += decoder.decode();
        if (buffer.trim()) parseAiStreamBuffer(`${buffer}\n`).events.forEach(applyEvent);

        const finalText = projection.buffer;
        if (failed || !doneReceived || !validationReceived || !finalText.trim()) {
          updatePreview("interrupted");
          if (!failed) {
            s.toast({
              kind: "danger",
              title: "Ответ ИИ не подтверждён",
              body: `Поток завершился без финального результата или проверки. Исходный текст и ключ запроса сохранены.${requestId ? ` Номер запроса: ${requestId}` : ""}`,
            });
          }
          return;
        }
        try {
          await acknowledgeAiTerminal(aiRequest.key, { signal: controller.signal });
        } catch (error) {
          if ((error as Error)?.name === "AbortError") throw error;
          setAiPreview({
            text: finalText,
            phase: projection.phase,
            status: "interrupted",
            requestId,
          });
          s.toast({
            kind: "danger",
            title: "Ответ ещё не подтверждён",
            body: `Текст сохранён на сервере, но подтверждение списания не завершилось. Повтори тот же запрос — модель не будет вызвана заново.${requestId ? ` Номер запроса: ${requestId}` : ""}`,
          });
          return;
        }
        setText(finalText);
        setAiValidation(streamState.payload);
        setAiReview(streamState.validation);
        setTopicOpen(false);
        setTopic("");
        setOrigin("ai");
        markDraftDirty();
        setAiPreview(null);
        aiRequestRef.current = null;
        if (streamState.validation !== "none") {
          s.toast({
            kind: streamState.validation === "blocked" ? "danger" : "info",
            title: streamState.validation === "blocked" ? "Текст заблокирован проверкой" : "Нужна ручная проверка",
            body: streamState.validation === "blocked"
              ? "Исправь отмеченные факты перед планированием."
              : "Проверь факты и нажми подтверждение под ИИ-помощником до планирования.",
          });
        }
      } catch (error) {
        updatePreview("interrupted");
        if ((error as Error)?.name !== "AbortError") {
          s.toast({
            kind: "danger",
            title: "Связь с ИИ прервалась",
            body: `Исходный текст и ключ запроса сохранены. Попробуй ещё раз.${requestId ? ` Номер запроса: ${requestId}` : ""}`,
          });
        }
      } finally {
        if (cancelRef.current === cancelCurrent) {
          cancelRef.current = null;
          setTyping(false);
          setAiBusy(null);
        }
        void s.refreshAiUsage();
      }
    },
    [
      channelId,
      markDraftDirty,
      networks,
      s,
      text,
      topic,
      typing,
      vkChannelId,
    ],
  );

  const applyAiPreview = useCallback(() => {
    if (!aiPreview?.text.trim() || aiPreview.status !== "interrupted") return;
    setText(aiPreview.text);
    setOrigin("ai");
    setAiValidation(null);
    setAiReview("required");
    setAiPreview(null);
    markDraftDirty();
  }, [aiPreview, markDraftDirty]);

  const dismissAiPreview = useCallback(() => {
    if (typing) return;
    setAiPreview(null);
  }, [typing]);

  /* ------------------------------------------------------------------ ВРЕМЯ */

  const quick = useCallback((kind: "hour" | "tomorrow" | "best") => {
    const now = new Date();
    let target: Date;

    if (kind === "hour") {
      target = new Date(now.getTime() + 3600_000);
      target.setSeconds(0, 0);
    } else if (kind === "tomorrow") {
      target = atTime(addDays(now, 1), "10:00");
    } else {
      if (!bestTime) return;
      target = nextMoscowPublishingSlot(bestTime.hour, now);
    }

    setNoDate(false);
    setDate(toDateValue(target));
    setTime(toTimeValue(target));
    markDraftDirty();
    setErrors((e) => ({ ...e, when: undefined }));
  }, [bestTime, markDraftDirty]);

  /* ------------------------------------------------------------- СОХРАНЕНИЕ */

  const validate = useCallback(
    (needWhen: boolean) => {
      const next: Errors = {};

      if (typing || cancelRef.current) next.text = "Дождись финальной проверки ИИ или останови генерацию.";
      if (!text.trim()) next.text = "Пост пустой. Напиши что-нибудь или попроси ИИ.";
      if (!networks.length) next.networks = "Выбери хотя бы одну сеть — иначе посту некуда идти.";
      if (needWhen && aiReview === "required") {
        next.text = "Проверь факты в тексте ИИ и подтверди ручную проверку перед планированием.";
      }
      if (needWhen && aiReview === "blocked") {
        next.text = "В тексте ИИ найдена критичная фактическая ошибка. Исправь текст и проверь его вручную.";
      }

      if (needWhen && !noDate) {
        const when = parseWhen(date, time);
        if (!when) next.when = "Поставь дату и время — или отметь «Без даты — в очередь».";
        else if (when.getTime() <= Date.now())
          next.when = "Это время уже прошло. Выбери будущее — или отправим в очередь без даты.";
      }

      setErrors(next);
      return next;
    },
    [aiReview, date, networks.length, noDate, text, time, typing],
  );

  const persistDraft = useCallback(
    (mode: DraftPersistMode = "manual"): Promise<ServerDraft | null> => {
      // setState асинхронен, поэтому одной disabled-кнопки недостаточно: два события в
      // одном кадре должны получить один и тот же Promise и один client_key.
      if (draftRequestRef.current) return draftRequestRef.current;

      const bad = validate(false);
      const first = bad.text ?? bad.networks;
      if (first) {
        setDraftSaveState("failed");
        if (mode !== "autosave") {
          s.toast({ kind: "danger", title: "Черновик не сохранён", body: first });
        }
        return Promise.resolve(null);
      }

      const selected: number[] = [];
      const missing: string[] = [];
      if (networks.includes("tg")) {
        if (channelId != null && tgChannels.some((channel) => channel.id === channelId)) {
          selected.push(channelId);
        } else missing.push("Telegram");
      }
      if (networks.includes("vk")) {
        if (vkChannelId != null && vkChannels.some((channel) => channel.id === vkChannelId)) {
          selected.push(vkChannelId);
        } else missing.push("VK");
      }
      if (missing.length) {
        const message = `Подключи или заново выбери: ${missing.join(" и ")}. Черновик не отправлен на сервер.`;
        setErrors((current) => ({ ...current, networks: message }));
        setDraftSaveState("failed");
        if (mode !== "autosave") {
          s.toast({ kind: "danger", title: "Нет активного назначения", body: message });
        }
        return Promise.resolve(null);
      }

      const when = noDate ? null : parseWhen(date, time);
      if (!noDate && (date || time) && !when) {
        const message = "Дата заполнена не полностью. Исправь её или выбери «Без даты».";
        setErrors((current) => ({ ...current, when: message }));
        setDraftSaveState("failed");
        if (mode !== "autosave") {
          s.toast({ kind: "danger", title: "Черновик не сохранён", body: message });
        }
        return Promise.resolve(null);
      }
      const scheduledAt = when ? when.toISOString() : null;
      const unchanged = reusableAcknowledgedDraft({
        draft: acknowledgedDraftRef.current,
        draftId,
        draftVersion,
        revision: draftRevisionRef.current,
        lastSavedRevision: lastSavedRevisionRef.current,
      });
      if (unchanged) return Promise.resolve(unchanged);
      const revisionAtStart = draftRevisionRef.current;
      return runSingleDraftSave(draftRequestRef, async (): Promise<ServerDraft | null> => {
        lastAttemptedRevisionRef.current = Math.max(
          lastAttemptedRevisionRef.current,
          revisionAtStart,
        );
        setLastAttemptedRevision((current) => Math.max(current, revisionAtStart));
        setDraftSaveState("saving");
        setDraftSavedAt(null);
        try {
          const common = {
            text,
            media: media ?? null,
            scheduledAt,
            origin,
            sourceRef: sourceRef ?? null,
            channelIds: selected,
            aiValidation: origin === "ai" ? aiValidation : null,
          };
          const clientKey = (draftClientKeyRef.current ??= createDraftClientKey());
          let draft: ServerDraft;
          if (draftId != null && draftVersion != null) {
            draft = await updateServerDraft(draftId, { ...common, version: draftVersion });
          } else {
            const created = await createServerDraft({
              ...common,
              clientKey,
            });
            if (!created.created && !draftMatchesWrite(created.draft, common)) {
              throw new DraftRequestError(
                "conflict",
                409,
                "idempotency_content_conflict",
                created.draft,
              );
            }
            draft = created.draft;
          }

          setDraftId(draft.id);
          setDraftVersion(draft.version);
          acknowledgedDraftRef.current = draft;
          setEditingId(`draft-${draft.id}`);
          draftClientKeyRef.current = draft.client_key;
          if (composerUserId != null) {
            // A newer local edit may already have replaced this record. Exact revision
            // matching prevents an older ACK from deleting that newer pending copy.
            acknowledgePendingDraft(composerUserId, clientKey, revisionAtStart);
          }
          // Меняем адрес только после ACK сервера. Hard reload теперь восстановит именно
          // серверную версию; локальная legacy-копия при этом остаётся нетронутой.
          window.history.replaceState(null, "", `/app/composer?draft=${draft.id}`);
          lastSavedRevisionRef.current = Math.max(lastSavedRevisionRef.current, revisionAtStart);
          setLastSavedRevision((current) => Math.max(current, revisionAtStart));
          if (draftRevisionRef.current !== revisionAtStart) {
            setDraftSaveState("idle");
            setDraftSavedAt(null);
            if (mode !== "autosave") {
              s.toast({
                kind: "info",
                title: "Появились новые изменения",
                body: "Предыдущая версия уже на сервере, но текущий текст изменился во время сохранения. Следующая версия сохранится автоматически.",
              });
            }
            return null;
          }
          // Validation belongs to the exact text revision acknowledged by this response.
          // If the user edited while the request was in flight, keep the newer local review
          // state; the next versioned autosave will persist it against the returned version.
          setAiValidation(draft.ai_validation);
          setAiReview(composerAiReviewState(draft));
          setDraftSaveState("saved");
          setDraftSavedAt(draft.updated_at);
          if (mode === "manual") {
            s.toast({
              kind: "success",
              title: "Черновик сохранён",
              body: legacyId
                ? "Серверная копия готова. Исходную локальную копию оставили для безопасного восстановления."
                : "Сохранено на сервере — черновик откроется и на другом устройстве.",
            });
          }
          return draft;
        } catch (error) {
          if (error instanceof DraftRequestError && error.kind === "offline") {
            setDraftSaveState("offline");
            if (mode !== "autosave") {
              s.toast({
                kind: "danger",
                title: "Нет связи с сервером",
                body: "Текст остался в редакторе, но ещё не сохранён. Не закрывай вкладку и повтори.",
              });
            }
          } else if (error instanceof DraftRequestError && error.kind === "conflict") {
            setDraftSaveState("conflict");
            s.toast({
              kind: "danger",
              title: "Черновик изменён в другой вкладке",
              body: "Эту версию не перезаписали. Актуальный серверный вариант можно открыть из календаря.",
            });
          } else {
            setDraftSaveState("failed");
            if (mode !== "autosave") {
              s.toast({
                kind: "danger",
                title: "Черновик не сохранён",
                body: "Сервер не подтвердил сохранение. Текст остался в редакторе — попробуй ещё раз.",
              });
            }
          }
          return null;
        }
      });
    },
    [
      channelId,
      aiValidation,
      composerUserId,
      date,
      draftId,
      draftVersion,
      legacyId,
      media,
      networks,
      noDate,
      origin,
      s,
      sourceRef,
      text,
      tgChannels,
      time,
      validate,
      vkChannelId,
      vkChannels,
    ],
  );

  const autosaveEligible = shouldAutosaveDraft({
    hydrated,
    revision: draftRevision,
    lastSavedRevision,
    lastAttemptedRevision,
    saveState: draftSaveState,
    hasText: Boolean(text.trim()),
    hasDestinations:
      networks.length > 0 &&
      networks.every((network) =>
        network === "tg" ? channelId != null : network === "vk" ? vkChannelId != null : false,
      ),
    scheduleValid:
      noDate || (!(date || time)) || Boolean(parseWhen(date, time)),
    busy: typing || saving,
  });

  // Durable write-through precedes the debounced network save. It intentionally records
  // incomplete form state too: a hard close immediately after a keystroke must not lose it.
  useEffect(() => {
    if (
      !hydrated || composerUserId == null || hydratedUserIdRef.current !== composerUserId
      || draftRevision <= lastSavedRevision
    ) return;
    const clientKey = (draftClientKeyRef.current ??= createDraftClientKey());
    const selected = [
      ...(networks.includes("tg") && channelId != null ? [channelId] : []),
      ...(networks.includes("vk") && vkChannelId != null ? [vkChannelId] : []),
    ];
    const when = noDate ? null : parseWhen(date, time);
    const durable = persistPendingDraft({
      schema: 1,
      userId: composerUserId,
      workspaceId: `personal:${composerUserId}`,
      clientKey,
      draftId,
      baseVersion: draftVersion,
      revision: draftRevision,
      writtenAt: new Date().toISOString(),
      payload: {
        text,
        media: media ?? null,
        scheduledAt: when?.toISOString() ?? null,
        origin,
        sourceRef: sourceRef ?? null,
        channelIds: selected,
        aiValidation: origin === "ai" ? aiValidation : null,
      },
      form: { networks, channelIds: selected, date, time, noDate },
    });
    if (!durable) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setDraftSaveState("failed");
      });
      return () => { cancelled = true; };
    }
  }, [
    aiValidation,
    channelId,
    composerUserId,
    date,
    draftId,
    draftRevision,
    draftVersion,
    hydrated,
    lastSavedRevision,
    media,
    networks,
    noDate,
    origin,
    sourceRef,
    text,
    time,
    vkChannelId,
  ]);

  useEffect(() => {
    if (!autosaveEligible) return;
    const revision = draftRevision;
    return scheduleDraftAutosave(() => {
      if (draftRevisionRef.current !== revision) return;
      void persistDraft("autosave");
    }, DRAFT_AUTOSAVE_DELAY_MS);
  }, [autosaveEligible, draftRevision, persistDraft]);

  useEffect(() => {
    const retry = () => {
      if (draftRevisionRef.current <= lastSavedRevisionRef.current) return;
      lastAttemptedRevisionRef.current = lastSavedRevisionRef.current;
      setLastAttemptedRevision(lastSavedRevisionRef.current);
      setDraftSaveState((state) => state === "conflict" ? state : "pending");
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);

  const saveDraft = useCallback(async () => {
    await persistDraft("manual");
  }, [persistDraft]);

  const confirmAiReview = useCallback(async () => {
    if (aiReview !== "required" || reviewRequestRef.current) return;
    reviewRequestRef.current = true;
    try {
      // Persist the exact current text first; the ACK then increments and binds itself to
      // that returned version. A concurrent tab receives 409 and cannot attest our copy.
      const persisted = await persistDraft("schedule");
      if (!persisted) return;
      const reviewRevision = draftRevisionRef.current;
      const acknowledged = await attestServerDraftReview(persisted.id, persisted.version);
      setDraftId(acknowledged.id);
      setDraftVersion(acknowledged.version);
      acknowledgedDraftRef.current = acknowledged;
      if (draftRevisionRef.current !== reviewRevision) {
        // The ACK is valid for the persisted server version, but not for text changed while
        // attestation was in flight. Preserve fail-closed local state and autosave the newer
        // revision against the acknowledged version before allowing another review.
        if (origin === "ai") {
          setAiValidation(null);
          setAiReview("required");
        }
        setDraftSaveState("idle");
        setDraftSavedAt(null);
        s.toast({
          kind: "info",
          title: "Текст изменился во время проверки",
          body: "Новая версия сохранится автоматически, после этого подтверди её ещё раз.",
        });
        return;
      }
      setAiValidation(acknowledged.ai_validation);
      setAiReview(composerAiReviewState(acknowledged));
      setDraftSaveState("saved");
      setDraftSavedAt(acknowledged.updated_at);
      s.toast({
        kind: "info",
        title: "Ручная проверка подтверждена сервером",
        body: "Отметка привязана к этой версии. После изменения текста потребуется новая проверка.",
      });
    } catch (error) {
      setDraftSaveState(
        error instanceof DraftRequestError && error.kind === "conflict" ? "conflict" : "failed",
      );
      s.toast({
        kind: "danger",
        title: "Проверка не подтверждена",
        body:
          error instanceof DraftRequestError && error.kind === "conflict"
            ? "Черновик изменён в другой вкладке. Открой актуальную версию и проверь её."
            : "Сервер не принял отметку. Планирование остаётся заблокированным.",
      });
    } finally {
      reviewRequestRef.current = false;
    }
  }, [aiReview, origin, persistDraft, s]);

  const schedule = useCallback(async () => {
    if (scheduleRequestRef.current) return;
    scheduleRequestRef.current = true;
    const bad = validate(true);
    const first = bad.text ?? bad.networks ?? bad.when;
    if (first) {
      s.toast({ kind: "danger", title: "Пост пока не готов", body: first });
      scheduleRequestRef.current = false;
      return;
    }

    setSaving(true);
    try {
      // Сначала фиксируем редактируемую версию на сервере. Если публикационная очередь
      // откажет, пользователь не потеряет текст и увидит его в календаре как черновик.
      const draft = await persistDraft("schedule");
      if (!draft) return;
      const scheduledAt = draft.scheduled_at;
      if (!scheduledAt) {
        s.toast({
          kind: "success",
          title: "Пост в очереди",
          body: "Черновик сохранён на сервере без даты. Поставишь время, когда решишь.",
        });
        router.push("/app/calendar");
        return;
      }

      const operation = (publicationOperationRef.current ??= {
        key: crypto.randomUUID(),
        fingerprint: null,
      });
      const result = await s.createPublicationOperation({
        draftId: draft.id,
        draftVersion: draft.version,
        idempotencyKey: operation.key,
        operationFingerprint: operation.fingerprint,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
      if (result.fingerprint) operation.fingerprint = result.fingerprint;
      if (
        result.ok && result.operationStatus === "queued"
        && result.destinations?.length === draft.destinations.length
      ) {
        // Удаляем только подтверждённую версию. Конфликт означает, что в другой вкладке
        // уже есть более свежий текст: его сохраняем, а не уничтожаем вслед за публикацией.
        await deleteServerDraft(draft.id, draft.version).catch(() => {});
        if (composerUserId != null && draftClientKeyRef.current) {
          removePendingDraft(composerUserId, draftClientKeyRef.current);
        }
        s.toast({
          kind: "success",
          title: "Пост запланирован",
          body: `${fmtDateTime(result.scheduledAt ?? scheduledAt)}. Все назначения используют одну подтверждённую версию.`,
        });
        publicationOperationRef.current = null;
        router.push("/app/calendar");
      } else {
        const publicationUnavailable = result.error === "publication_worker_unavailable";
        s.toast({
          kind: "danger",
          title: publicationUnavailable
            ? "Публикация временно недоступна"
            : result.error?.includes("conflict")
            ? "Версия операции изменилась"
            : "Операция принята частично",
          body: publicationUnavailable
            ? "Фоновый обработчик не запущен. Черновик сохранён — запусти сервер через npm run dev и повтори планирование."
            : result.error?.includes("conflict")
            ? "Повтор не смешал новый текст со старой отправкой. Черновик сохранён; проверь назначения в календаре."
            : "Черновик не удалён. Успешные и ожидающие назначения показаны отдельно в календаре.",
        });
      }
    } finally {
      setSaving(false);
      scheduleRequestRef.current = false;
    }
  }, [composerUserId, persistDraft, router, s, validate]);

  const removeCurrent = useCallback(async () => {
    if (!editingId) return;
    if (draftId != null && draftVersion != null) {
      setDraftSaveState("saving");
      try {
        await deleteServerDraft(draftId, draftVersion);
        acknowledgedDraftRef.current = null;
        if (composerUserId != null && draftClientKeyRef.current) {
          removePendingDraft(composerUserId, draftClientKeyRef.current);
        }
      } catch (error) {
        setDraftSaveState(
          error instanceof DraftRequestError && error.kind === "offline"
            ? "offline"
            : error instanceof DraftRequestError && error.kind === "conflict"
              ? "conflict"
              : "failed",
        );
        s.toast({
          kind: "danger",
          title: "Черновик не удалён",
          body:
            error instanceof DraftRequestError && error.kind === "conflict"
              ? "Его изменили в другой вкладке. Более свежую версию не удалили."
              : "Сервер не подтвердил удаление. Обнови страницу и попробуй ещё раз.",
        });
        return;
      }
    } else if (legacyId) {
      // Только явное подтверждение пользователя удаляет локальную recovery-копию.
      s.removePost(legacyId);
    }
    s.toast({ kind: "info", title: "Черновик удалён" });
    router.push("/app/calendar");
  }, [composerUserId, draftId, draftVersion, editingId, legacyId, router, s]);

  const value = useMemo<ComposerValue>(
    () => ({
      hydrated,
      editingId,
      draftId,
      text,
      setText: changeText,
      networks,
      setNetworks: changeNetworks,
      toggleNetwork,
      tgChannels,
      vkChannels,
      channelId,
      setChannelId: changeChannelId,
      vkChannelId,
      setVkChannelId: changeVkChannelId,
      media,
      setMedia: changeMedia,
      sourceRef,
      date,
      setDate: changeDate,
      time,
      setTime: changeTime,
      noDate,
      setNoDate: changeNoDate,
      aiBusy,
      typing,
      aiPreview,
      applyAiPreview,
      dismissAiPreview,
      aiReview,
      confirmAiReview,
      topicOpen,
      setTopicOpen,
      topic,
      setTopic,
      errors,
      confirmDelete,
      setConfirmDelete,
      draftSaveState,
      draftSavedAt,
      bestTime,
      saving,
      runAi,
      stopAi,
      quick,
      schedule,
      saveDraft,
      removeCurrent,
      hydrate,
    }),
    [
      aiBusy,
      aiPreview,
      aiReview,
      applyAiPreview,
      channelId,
      changeChannelId,
      changeDate,
      changeMedia,
      changeNetworks,
      changeNoDate,
      changeText,
      changeTime,
      changeVkChannelId,
      confirmDelete,
      confirmAiReview,
      date,
      draftId,
      draftSavedAt,
      draftSaveState,
      dismissAiPreview,
      bestTime,
      editingId,
      errors,
      hydrate,
      hydrated,
      media,
      networks,
      noDate,
      tgChannels,
      vkChannels,
      vkChannelId,
      quick,
      removeCurrent,
      runAi,
      saveDraft,
      saving,
      schedule,
      sourceRef,
      stopAi,
      text,
      time,
      topic,
      topicOpen,
      toggleNetwork,
      typing,
    ],
  );

  return (
    <ComposerCtx.Provider value={value}>
      <AppShell
        title="Редактор поста"
        subtitle="Один пост — обе сети. Предпросмотр покажет, как он будет выглядеть."
        action={<ScheduleButton />}
      >
        <Suspense fallback={<ComposerSkeleton />}>
          <ComposerInner />
        </Suspense>
      </AppShell>
    </ComposerCtx.Provider>
  );
}

/* ------------------------------------------------- ГЛАВНОЕ ДЕЙСТВИЕ (шапка) */
// Единственный градиент на экране — правило ТЗ 7.2 («магнит»).

function ScheduleButton() {
  const c = useComposer();
  return (
    <Button
      variant="brand"
      size="lg"
      onClick={c.schedule}
      disabled={!c.hydrated || c.draftSaveState === "saving" || c.typing}
      loading={c.saving}
      className="glow-pulse"
    >
      {!c.saving && <CalendarClock className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />}
      {c.noDate ? "Отправить в очередь" : "Запланировать"}
    </Button>
  );
}

/* ---------------------------------------------------------------- РЕДАКТОР */

function ComposerInner() {
  const s = useStore();
  const params = useSearchParams();
  const reduce = useReducedMotion();
  const c = useComposer();
  const [mobilePane, setMobilePane] = useState<"editor" | "preview">("editor");

  const idParam = params.get("id");
  const draftParam = Number(params.get("draft")) || null;
  const legacyParam = params.get("legacy") ?? idParam;
  const dateRaw = params.get("date");
  const dateParam = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
    ? dateRaw
    : dateRaw && !Number.isNaN(new Date(dateRaw).getTime())
      ? toDateValue(new Date(dateRaw))
      : dateRaw;
  const timeParam = params.get("time");
  const channelParam = Number(params.get("channel")) || null;
  const fromMedia = params.get("fromMedia") === "1";

  const {
    hydrate,
    hydrated,
    draftId: currentDraftId,
    text,
    typing,
    setChannelId: setComposerChannelId,
    setVkChannelId: setComposerVkChannelId,
    setNetworks: setComposerNetworks,
  } = c;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const topicRef = useRef<HTMLInputElement>(null);
  const loadedKey = useRef<string | null>(null);
  const storeReady = s.ready;
  const authReady = s.authReady;
  const realReady = s.realReady;
  const realChannels = s.realChannels;
  const localPosts = s.posts;
  const currentUserId = s.user?.id ?? null;
  const toast = s.toast;

  // Pending outbox is selected before the server snapshot, so a hard reload never flashes
  // and then overwrites the newer local text with an older acknowledged version.
  useEffect(() => {
    if (!storeReady || !authReady || !realReady) return;
    const key = composerHydrationIdentity({
      userId: currentUserId,
      draftId: draftParam,
      legacyId: legacyParam,
      channelId: channelParam,
      date: dateParam,
      time: timeParam,
      fromMedia,
    });
    if (draftParam && currentDraftId === draftParam && hydrated) {
      loadedKey.current = key;
      return;
    }
    if (loadedKey.current === key) return;

    const controller = new AbortController();
    let cancelled = false;
    const defaultNetworks = activeComposerNetworks(realChannels);

    void (async () => {
      let draft: ServerDraft | null = null;
      let post: Post | null = null;
      const pending = currentUserId == null
        ? null
        : draftParam
          ? findPendingDraft(currentUserId, { draftId: draftParam })
          : !legacyParam && !fromMedia
            ? listPendingDrafts(currentUserId)[0] ?? null
            : null;
      if (draftParam) {
        try {
          draft = await getServerDraft(draftParam, controller.signal);
          post = draftToPost(draft);
        } catch (error) {
          if (cancelled) return;
          toast({
            kind: pending ? "info" : "danger",
            title: pending ? "Открыта локальная версия" : "Черновик не загрузился",
            body:
              pending
                ? "Сервер пока недоступен. Несинхронизированный текст сохранён в этом браузере и будет отправлен после восстановления сети."
                : error instanceof DraftRequestError && error.kind === "offline"
                ? "Нет сети. Открыл чистый лист, не меняя серверный черновик."
                : "Возможно, черновик удалён или открыт не из этого аккаунта. Серверные данные не менялись.",
          });
        }
      } else if (legacyParam) {
        post = localPosts.find(
          (candidate) =>
            candidate.id === legacyParam &&
            currentUserId != null &&
            isRecoverableLegacyDraft(candidate, currentUserId),
        ) ?? null;
        if (!post) {
          toast({
            kind: "info",
            title: "Локальная копия не нашлась",
            body: "Её могли удалить в этом браузере. Открыл чистый лист, серверные черновики не менялись.",
          });
        }
      }
      if (cancelled) return;

      let generatedMedia: Post["media"] = null;
      if (fromMedia) {
        try {
          generatedMedia = JSON.parse(sessionStorage.getItem("aurora:generated-media") || "null") as Post["media"];
        } catch {
          generatedMedia = null;
        }
        sessionStorage.removeItem("aurora:generated-media");
      }
      hydrate({
        ownerUserId: currentUserId,
        post,
        draft,
        pending,
        pendingConflict: Boolean(
          pending && draft && pending.baseVersion !== null && pending.baseVersion !== draft.version,
        ),
        date: dateParam,
        time: timeParam,
        media: generatedMedia,
        defaultNetworks,
      });
      loadedKey.current = key;

      const requestedChannel = channelParam
        ? realChannels.find((channel) => channel.id === channelParam && channel.is_active)
        : null;
      if (!draft && requestedChannel?.network === "tg") {
        setComposerChannelId(requestedChannel.id);
        setComposerNetworks(["tg"]);
      } else if (!draft && requestedChannel?.network === "vk") {
        setComposerVkChannelId(requestedChannel.id);
        setComposerNetworks(["vk"]);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    channelParam,
    currentDraftId,
    currentUserId,
    dateParam,
    draftParam,
    fromMedia,
    hydrate,
    hydrated,
    legacyParam,
    authReady,
    localPosts,
    realChannels,
    realReady,
    setComposerChannelId,
    setComposerNetworks,
    setComposerVkChannelId,
    storeReady,
    timeParam,
    toast,
  ]);

  // ИИ печатает — держим видимым хвост текста
  useEffect(() => {
    if (typing && taRef.current) taRef.current.scrollTop = taRef.current.scrollHeight;
  }, [text, typing]);

  useEffect(() => {
    if (c.topicOpen) topicRef.current?.focus();
  }, [c.topicOpen]);

  if (!s.ready || !hydrated) return <ComposerSkeleton />;

  const len = text.length;
  // Лимит считаем по выбранной сети: TG режет на 4096, VK терпит до 16384.
  // Если включены обе — ориентиром служит более строгий telegram-лимит.
  const effLimit = c.networks.includes("tg")
    ? NETWORK_LIMIT.tg ?? TG_LIMIT
    : NETWORK_LIMIT.vk ?? VK_LIMIT;
  const over = len > effLimit;
  const tgOn = c.networks.includes("tg");
  const vkOn = c.networks.includes("vk");
  const aiUsage = getAiUsageMetrics(s.aiUsageStatus, s.aiUsed, s.aiLimit);
  const when = parseWhen(c.date, c.time);

  // Предпросмотр обязан показывать ТОТ канал, в который уйдёт пост. Раньше он всегда брал
  // демо-канал из моков — при одном канале это была незаметная условность, но теперь человек
  // выбирает канал сам, и чужое имя в превью прямо противоречило бы его выбору.
  const pickedCh = c.tgChannels.find((ch) => ch.id === c.channelId);
  const tgCh = pickedCh
    ? {
        name: pickedCh.title ?? "Твой канал",
        handle: pickedCh.handle ? `@${pickedCh.handle.replace(/^@/, "")}` : "",
        subscribers: 0,
      }
    : { name: "Telegram не выбран", handle: "", subscribers: 0 };
  const pickedVk = c.vkChannels.find((ch) => ch.id === c.vkChannelId);
  const vkCh = pickedVk
    ? { name: pickedVk.title ?? "Твоё сообщество", subscribers: 0 }
    : { name: "VK не выбран", subscribers: 0 };
  const aiContextDestination = tgOn ? pickedCh : vkOn ? pickedVk : null;

  const aiActions: { cmd: ComposerAiCommand; label: string; icon: React.ReactNode }[] = [
    { cmd: "write", label: "Напиши", icon: <Sparkles className="h-4 w-4" aria-hidden /> },
    { cmd: "rewrite", label: "Перепиши", icon: <RefreshCw className="h-4 w-4" aria-hidden /> },
    { cmd: "shorten", label: "Сократи", icon: <Scissors className="h-4 w-4" aria-hidden /> },
    {
      cmd: "script",
      label: "Сценарий видео",
      icon: <Clapperboard className="h-4 w-4" aria-hidden />,
    },
  ];

  const addMedia = (kind: "image" | "video") =>
    c.setMedia({
      kind,
      label: kind === "video" ? "Вертикалка 9:16" : "Фото к посту",
      hue: Math.floor(Math.random() * 360),
    });

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      c.schedule();
    }
  };

  const fade = {
    initial: { opacity: 0, y: reduce ? 0 : -6 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: reduce ? 0 : -6 },
    transition: { duration: reduce ? 0 : 0.2, ease: "easeOut" as const },
  };

  return (
    <>
      <div
        role="group"
        aria-label="Редактор или предпросмотр"
        className="grid grid-cols-2 gap-1 rounded-sm border border-line bg-surface-inset p-1 lg:hidden"
      >
        {(["editor", "preview"] as const).map((pane) => (
          <button
            key={pane}
            type="button"
            aria-pressed={mobilePane === pane}
            onClick={() => setMobilePane(pane)}
            className={cn(
              "min-h-11 rounded-xs px-3 text-[14px] font-semibold",
              mobilePane === pane ? "bg-surface text-text shadow-soft" : "text-text-2",
            )}
          >
            {pane === "editor" ? "Редактор" : "Предпросмотр"}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* ------------------------------------------------------ ЛЕВО: РЕДАКТОР */}
      <Card
        className={cn(
          "min-w-0 flex-1 space-y-6 p-5 sm:p-6",
          mobilePane === "preview" && "hidden lg:block",
        )}
      >
        {c.sourceRef && <SourcePlate source={c.sourceRef} />}

        <Field label="Текст поста" htmlFor="composer-text" error={c.errors.text}>
          <div>
            <Textarea
              id="composer-text"
              ref={taRef}
              rows={7}
              value={text}
              readOnly={typing}
              aria-busy={typing || undefined}
              onChange={(e) => c.setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Пиши как обычно — или нажми «Напиши», и ИИ начнёт за тебя."
              className={cn("min-h-[180px] sm:min-h-[280px]", typing && "cursor-progress")}
            />

            <div className="mt-2 flex items-start justify-between gap-4">
              {over ? (
                <p className="text-[13px] font-medium text-danger">
                  {c.networks.includes("tg")
                    ? `Для Telegram лимит ${fmtNum(TG_LIMIT)} символов — VK стерпит, Telegram обрежет.`
                    : `Для VK лимит ${fmtNum(VK_LIMIT)} символов — сократи текст.`}
                </p>
              ) : (
                <p className="text-[13px] text-text-3">Ctrl + Enter — запланировать</p>
              )}
              <span className="nums shrink-0 text-[13px] text-text-3">{chars(len)}</span>
            </div>
          </div>
        </Field>

        {/* --------------------------------------------------------------- ИИ */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-semibold text-text-2">ИИ-помощник</p>
            <p className="nums text-[13px] text-text-3">
              {aiUsage
                ? `осталось ${fmtNum(aiUsage.left)} из ${fmtNum(aiUsage.limit)} генераций на сегодня`
                : s.aiUsageStatus === "loading"
                  ? "проверяем лимит генераций…"
                  : "счётчик генераций временно недоступен"}
            </p>
          </div>
          {aiContextDestination && (
            <p className="text-[12px] leading-relaxed text-text-3">
              Контекст ИИ: {aiContextDestination.title ?? aiContextDestination.handle ?? `канал #${aiContextDestination.id}`}
              {tgOn && vkOn ? " · единый текст для Telegram и VK" : ""}
            </p>
          )}

          <AnimatePresence initial={false}>
            {c.topicOpen && (
              <motion.div key="topic" {...fade} className="flex flex-wrap gap-2">
                <Input
                  ref={topicRef}
                  value={c.topic}
                  onChange={(e) => c.setTopic(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      c.runAi("write");
                    }
                    if (e.key === "Escape") c.setTopicOpen(false);
                  }}
                  placeholder="О чём пост?"
                  className="min-w-0 flex-1"
                  aria-label="Тема поста"
                />
                <Button variant="soft" onClick={() => c.runAi("write")} className="shrink-0">
                  <Sparkles className="h-[18px] w-[18px]" aria-hidden />
                  Написать
                </Button>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex flex-wrap gap-2">
            {aiActions.map((a) => (
              <Button
                key={a.cmd}
                variant="soft"
                size="sm"
                loading={c.aiBusy === a.cmd}
                disabled={typing && c.aiBusy !== a.cmd}
                onClick={() => c.runAi(a.cmd)}
              >
                {c.aiBusy === a.cmd ? null : a.icon}
                {a.label}
              </Button>
            ))}
          </div>

          <AnimatePresence initial={false}>
            {c.aiPreview && (
              <motion.section
                key="ai-preview"
                {...fade}
                aria-label="Предварительный вариант от ИИ"
                aria-busy={c.aiPreview.status === "running" || undefined}
                className={cn(
                  "space-y-3 rounded-sm border p-3",
                  c.aiPreview.status === "interrupted"
                    ? "border-fire/30 bg-fire-soft/50"
                    : "border-brand/25 bg-info-soft/50",
                )}
              >
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-text">Новый вариант</p>
                    <p role="status" aria-live="polite" aria-atomic="true" className="text-[12px] text-text-3">
                      {c.aiPreview.status === "running"
                        ? aiDraftPhaseLabel(c.aiPreview.phase)
                        : "Поток остановился. Готовая часть сохранена отдельно; исходный пост не изменён."}
                    </p>
                  </div>
                  {c.aiPreview.requestId && (
                    <span className="nums text-[11px] text-text-3">Номер: {c.aiPreview.requestId}</span>
                  )}
                </div>
                <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-xs bg-surface px-3 py-2 text-[14px] leading-relaxed text-text">
                  {c.aiPreview.text}
                </div>
                {c.aiPreview.status === "interrupted" && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="soft" size="sm" onClick={c.applyAiPreview}>
                      Использовать сохранённую часть
                    </Button>
                    <Button variant="ghost" size="sm" onClick={c.dismissAiPreview}>
                      Закрыть
                    </Button>
                  </div>
                )}
              </motion.section>
            )}
            {c.aiReview !== "none" && !typing && (
              <motion.div
                key="ai-review"
                {...fade}
                role={c.aiReview === "blocked" ? "alert" : "status"}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-sm px-3 py-2",
                  c.aiReview === "blocked" ? "bg-danger-soft text-danger-text" : "bg-fire-soft text-fire-text",
                )}
              >
                <span className="text-[13px] font-semibold">
                  {c.aiReview === "blocked"
                    ? "Проверка нашла спорные утверждения. Исправь или удали их в тексте — после изменения можно будет подтвердить факты и выбрать дату."
                    : "Семантическая проверка недоступна — проверь факты вручную."}
                </span>
                {c.aiReview === "required" && (
                  <Button variant="outline" size="sm" onClick={c.confirmAiReview} className="ml-auto">
                    Я проверил(а) факты
                  </Button>
                )}
              </motion.div>
            )}
            {typing && (
              <motion.div
                key="typing"
                {...fade}
                className="flex items-center gap-2 rounded-sm bg-info-soft px-3 py-2"
              >
                <Sparkles className="h-4 w-4 animate-pulse text-brand motion-reduce:animate-none" aria-hidden />
                <span role="status" aria-live="polite" aria-atomic="true" className="text-[13px] font-semibold text-info-text">
                  {c.aiPreview ? aiDraftPhaseLabel(c.aiPreview.phase) : "ИИ готовит черновик…"}
                </span>
                <Button variant="ghost" size="sm" onClick={c.stopAi} className="ml-auto">
                  <CircleStop className="h-4 w-4" aria-hidden />
                  Стоп
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <Divider />

        {/* ------------------------------------------------------------ МЕДИА */}
        <div className="space-y-3">
          <p className="text-[13px] font-semibold text-text-2">Медиа</p>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => addMedia("image")}>
              <ImageIcon className="h-4 w-4" aria-hidden />
              {c.media?.kind === "image" ? "Заменить фото" : "Добавить фото"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => addMedia("video")}>
              <Video className="h-4 w-4" aria-hidden />
              {c.media?.kind === "video" ? "Заменить видео" : "Добавить видео"}
            </Button>
          </div>

          <AnimatePresence initial={false}>
            {c.media && (
              <motion.div
                key="media"
                {...fade}
                className="flex items-center gap-3 rounded-sm border border-line bg-surface-2 p-3"
              >
                <div
                  className="relative h-14 w-20 shrink-0 overflow-hidden rounded-xs"
                  style={mediaStyle(c.media.hue)}
                  aria-hidden
                >
                  <span className="absolute inset-0 flex items-center justify-center text-white">
                    {c.media.kind === "video" ? (
                      <Video className="h-5 w-5" strokeWidth={2} />
                    ) : (
                      <ImageIcon className="h-5 w-5" strokeWidth={2} />
                    )}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-text">{c.media.label}</p>
                  <p className="truncate text-[13px] text-text-3">
                    {c.media.kind === "video" ? "Видео" : "Изображение"} · размер подгоним под каждую
                    сеть
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Убрать медиа"
                  onClick={() => c.setMedia(null)}
                >
                  <X className="h-[18px] w-[18px]" aria-hidden />
                </Button>
              </motion.div>
            )}
          </AnimatePresence>

          <p className="text-[13px] text-text-3">
            Готовые изображения и видео из ИИ-студии сохраняются вместе с постом.
          </p>
        </div>

        <Divider />

        {/* ------------------------------------------------------------- СЕТИ */}
        <div className="space-y-3">
          <p className="text-[13px] font-semibold text-text-2">Куда публикуем</p>

          <div className="flex flex-wrap items-center gap-6">
            {(c.tgChannels.length > 0 || tgOn) && (
              <Checkbox
                id="net-tg"
                checked={tgOn}
                onChange={(v) => c.toggleNetwork("tg", v)}
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <TelegramIcon className="h-4 w-4 text-text-2" />
                    Telegram{c.tgChannels.length === 0 ? " — канал отключён" : ""}
                  </span>
                }
              />
            )}
            {(c.vkChannels.length > 0 || vkOn) && (
              <Checkbox
                id="net-vk"
                checked={vkOn}
                onChange={(v) => c.toggleNetwork("vk", v)}
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <VkIcon className="h-4 w-4 text-text-2" />
                    VK{c.vkChannels.length === 0 ? " — сообщество отключено" : ""}
                  </span>
                }
              />
            )}
          </div>

          {c.tgChannels.length === 0 && c.vkChannels.length === 0 && !tgOn && !vkOn && (
            <p className="text-[13px] text-text-2">
              Подключи хотя бы один канал. Серверный черновик всегда хранит точные назначения.
            </p>
          )}

          {c.errors.networks && (
            <p role="alert" className="text-[13px] font-medium text-danger-text">
              {c.errors.networks}
            </p>
          )}

          {/* Выбор канала — только при нескольких. У кого канал один, тому нечего решать,
              и лишний селектор был бы шумом. */}
          {tgOn && (c.tgChannels.length > 1 || c.channelId == null) && (
            <div className="space-y-2 pt-1">
              <p className="text-[13px] font-semibold text-text-2">В какой канал</p>
              <div className="flex flex-wrap gap-2">
                {c.tgChannels.map((ch) => {
                  const on = c.channelId === ch.id;
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => c.setChannelId(ch.id)}
                      aria-pressed={on}
                      className={cn(
                        "inline-flex h-11 max-w-full cursor-pointer items-center gap-2 rounded-xs px-3.5",
                        "text-[14px] font-semibold transition-colors duration-200",
                        on
                          ? "bg-info-soft text-info-text ring-1 ring-brand/30 ring-inset"
                          : "bg-surface-inset text-text-2 hover:text-text",
                      )}
                    >
                      <TelegramIcon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{ch.title ?? ch.handle ?? `Канал ${ch.id}`}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {vkOn && (c.vkChannels.length > 1 || c.vkChannelId == null) && (
            <div className="space-y-2 pt-1">
              <p className="text-[13px] font-semibold text-text-2">В какое сообщество</p>
              <div className="flex flex-wrap gap-2">
                {c.vkChannels.map((ch) => {
                  const on = c.vkChannelId === ch.id;
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      onClick={() => c.setVkChannelId(ch.id)}
                      aria-pressed={on}
                      className={cn(
                        "inline-flex h-11 max-w-full cursor-pointer items-center gap-2 rounded-xs px-3.5",
                        "text-[14px] font-semibold transition-colors duration-200",
                        on
                          ? "bg-info-soft text-info-text ring-1 ring-brand/30 ring-inset"
                          : "bg-surface-inset text-text-2 hover:text-text",
                      )}
                    >
                      <VkIcon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{ch.title ?? ch.handle ?? `Сообщество ${ch.id}`}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ------------------------------------------------------------ ВРЕМЯ */}
        <Field
          label="Когда публикуем"
          error={c.errors.when}
          hint="Публикует сервер — компьютер можно выключить."
        >
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                type="date"
                value={c.date}
                disabled={c.noDate}
                aria-label="Дата публикации"
                onChange={(e) => c.setDate(e.target.value)}
                className="w-[176px] nums"
              />
              <Input
                type="time"
                value={c.time}
                disabled={c.noDate}
                aria-label="Время публикации"
                onChange={(e) => c.setTime(e.target.value)}
                className="w-[136px] nums"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="soft"
                size="sm"
                disabled={c.noDate}
                onClick={() => c.quick("hour")}
              >
                <Clock className="h-4 w-4" aria-hidden />
                Через час
              </Button>
              <Button
                variant="soft"
                size="sm"
                disabled={c.noDate}
                onClick={() => c.quick("tomorrow")}
              >
                <CalendarClock className="h-4 w-4" aria-hidden />
                Завтра 10:00
              </Button>
              {c.bestTime ? (
                <Button
                  variant="soft"
                  size="sm"
                  disabled={c.noDate}
                  onClick={() => c.quick("best")}
                  className="gap-2"
                  title={`Среднее ${c.bestTime.averageViews} просмотров; всего в расчёте ${c.bestTime.totalSample} подтверждённых постов`}
                >
                  <TrendingUp className="h-4 w-4" aria-hidden />
                  Лучшее время ({String(c.bestTime.hour).padStart(2, "0")}:00 МСК)
                  <Badge tone="brand">
                    {c.bestTime.sampleSize} в этом часу · {
                      c.bestTime.confidence === "high"
                        ? "высокая"
                        : c.bestTime.confidence === "medium"
                          ? "средняя"
                          : "низкая"
                    } уверенность
                  </Badge>
                </Button>
              ) : (
                <p className="self-center text-[12px] leading-relaxed text-text-3">
                  Лучшее время появится после 3 подтверждённых постов с метриками.
                </p>
              )}
            </div>

            <Checkbox
              id="no-date"
              checked={c.noDate}
              onChange={c.setNoDate}
              label="Без даты — в очередь"
            />
          </div>
        </Field>

        <Divider />

        {/* --------------------------------------------------------- ДЕЙСТВИЯ */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={c.saveDraft}
              loading={c.draftSaveState === "saving"}
              disabled={c.saving || c.typing}
            >
              {c.draftSaveState === "saved" ? "Сохранено" : "Сохранить как черновик"}
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                const text = c.text.trim();
                if (!text) return;
                try {
                  const r = await fetch("/api/library/posts", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      channelId: c.networks.includes("tg") ? c.channelId : c.vkChannelId,
                      text,
                    }),
                  });
                  if (r.ok) {
                    s.toast({ kind: "success", title: "Сохранено в библиотеку" });
                  } else {
                    s.toast({ kind: "danger", title: "Не удалось сохранить" });
                  }
                } catch {
                  s.toast({ kind: "danger", title: "Сетевая ошибка" });
                }
              }}
              disabled={!c.text.trim() || c.typing}
            >
              <Bookmark className="h-[18px] w-[18px]" aria-hidden />
              В библиотеку
            </Button>
            {c.editingId && (
              <Button
                variant="danger"
                disabled={c.draftSaveState === "saving" || c.saving || c.typing}
                onClick={() => c.setConfirmDelete(true)}
              >
                <Trash2 className="h-[18px] w-[18px]" aria-hidden />
                Удалить
              </Button>
            )}
          </div>
          <div className="text-right text-[13px]" aria-live="polite">
            {c.draftSaveState === "saving" ? (
              <p className="font-medium text-brand">Сохраняем на сервере…</p>
            ) : c.draftSaveState === "saved" ? (
              <p className="font-medium text-success">
                Сохранено{c.draftSavedAt ? ` в ${fmtTime(c.draftSavedAt)}` : ""}
              </p>
            ) : c.draftSaveState === "pending" ? (
              <p className="max-w-[360px] font-medium text-brand">
                Изменения сохранены в браузере и ожидают подтверждения сервера.
              </p>
            ) : c.draftSaveState === "offline" ? (
              <p className="max-w-[360px] font-medium text-danger-text">
                Нет сети: изменения сохранены в браузере и синхронизируются после подключения.
              </p>
            ) : c.draftSaveState === "conflict" ? (
              <p className="max-w-[360px] font-medium text-danger-text">
                Есть более свежая версия в другой вкладке. Текущую не перезаписали.{" "}
                <Link href="/app/calendar" className="underline underline-offset-2">
                  Открыть из календаря
                </Link>
              </p>
            ) : c.draftSaveState === "failed" ? (
              <p className="max-w-[360px] font-medium text-danger-text">
                Черновик ещё не сохранён. Проверь ошибки в полях или повтори попытку.
              </p>
            ) : (
              <p className="text-text-3">
                Несохранённые изменения автоматически сохранятся после заполнения текста, канала
                и корректной даты, если она нужна.
              </p>
            )}
          </div>
        </div>

        <AnimatePresence initial={false}>
          {c.confirmDelete && (
            <motion.div key="confirm" {...fade}>
              <div className="rounded-sm border border-danger/30 bg-danger-soft p-4">
                <p className="text-[15px] font-bold text-danger-text">
                  Удалить пост? Это нельзя отменить.
                </p>
                <p className="mt-1 text-[14px] leading-relaxed text-danger-text/80">
                  Он исчезнет и из календаря, и из очереди. Восстановить не получится.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="danger" onClick={c.removeCurrent}>
                    <Trash2 className="h-[18px] w-[18px]" aria-hidden />
                    Да, удалить
                  </Button>
                  <Button variant="ghost" onClick={() => c.setConfirmDelete(false)}>
                    Оставить
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>

      {/* -------------------------------------------------- ПРАВО: ПРЕДПРОСМОТР */}
      <aside
        className={cn(
          "w-full shrink-0 space-y-4 lg:sticky lg:top-6 lg:block lg:w-[380px]",
          mobilePane === "editor" && "hidden",
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[17px] font-extrabold tracking-tight text-text">Как это увидят</h2>
          <span className="text-[13px] text-text-3">обновляется на лету</span>
        </div>

        {tgOn && pickedCh && (
          <TelegramPreview
            on
            text={text}
            media={c.media}
            typing={typing}
            name={tgCh.name}
            handle={tgCh.handle}
            subscribers={tgCh.subscribers}
            when={c.noDate ? "в очереди" : c.time || "—"}
          />
        )}

        {vkOn && pickedVk && (
          <VkPreview
            on
            text={text}
            media={c.media}
            typing={typing}
            name={vkCh.name}
            subscribers={vkCh.subscribers}
            when={
              c.noDate
                ? "в очереди · без даты"
                : when
                  ? `${fmtDate(when.toISOString())} в ${c.time}`
                  : "дата не выбрана"
            }
          />
        )}

        {!((tgOn && pickedCh) || (vkOn && pickedVk)) && (
          <EmptyState
            icon={<Eye className="h-5 w-5" strokeWidth={1.5} aria-hidden />}
            title="Выбери активный канал"
            body="Предпросмотр появится только для реального назначения этого черновика."
          />
        )}

        <p className="text-[13px] leading-relaxed text-text-3">
          Различия сетей платформа учтёт сама: длину, разметку и размер картинки. Метрики появятся
          только после настоящей публикации.
        </p>
      </aside>
      </div>
    </>
  );
}

/* ------------------------------------------------------- ПЛАШКА «ИЗ РАЗВЕДКИ» */

function SourcePlate({ source }: { source: NonNullable<Post["sourceRef"]> }) {
  const href = source.kind === "competitor"
    ? `/app/competitors/${source.id}`
    : source.kind === "trend"
      ? "/app/trends"
      : "/app/library";

  return (
    <div className="flex items-center gap-3 rounded-sm bg-fire-soft px-4 py-2.5">
      <Flame className="h-[18px] w-[18px] shrink-0 text-fire" strokeWidth={2} aria-hidden />
      <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-fire-text">
        Из разведки: {source.label}
      </p>
      <Link
        href={href}
        className="-mx-2 inline-flex min-h-11 shrink-0 items-center gap-1 px-2 text-[13px] font-semibold text-fire-text transition-opacity duration-200 hover:opacity-70"
      >
        Открыть
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------- ПРЕДПРОСМОТРЫ */

interface PreviewProps {
  on: boolean;
  text: string;
  media: Post["media"];
  typing: boolean;
  name: string;
  subscribers: number;
  when: string;
}

function PreviewHead({ network, on }: { network: Network; on: boolean }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-text-2">
        {network === "tg" ? (
          <TelegramIcon className="h-4 w-4" />
        ) : (
          <VkIcon className="h-4 w-4" />
        )}
        {network === "tg" ? "Telegram" : "VK"}
      </span>
      {!on && <span className="text-[13px] font-medium text-text-3">Сеть отключена</span>}
    </div>
  );
}

function PreviewText({ value, typing }: { value: string; typing: boolean }) {
  return (
    <p className="max-h-[280px] overflow-y-auto text-[15px] leading-relaxed whitespace-pre-wrap break-words text-text">
      {value ? (
        value
      ) : (
        <span className="text-text-3">
          Здесь появится твой пост. Начни печатать — или попроси ИИ.
        </span>
      )}
      {typing && <span className="caret" aria-hidden />}
    </p>
  );
}

function MediaBlock({ media, className }: { media: NonNullable<Post["media"]>; className?: string }) {
  return (
    <div
      className={cn("relative overflow-hidden rounded-sm", className)}
      style={media.url ? undefined : mediaStyle(media.hue)}
      aria-hidden
    >
      {media.url && media.kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={media.url} alt="" className="h-full w-full object-cover" />
      )}
      {media.url && media.kind === "video" && (
        <video src={media.url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-black/25 px-3 py-1.5 text-[13px] font-semibold text-white backdrop-blur-[2px]">
        {media.kind === "video" ? (
          <Video className="h-4 w-4" strokeWidth={2} />
        ) : (
          <ImageIcon className="h-4 w-4" strokeWidth={2} />
        )}
        {media.label}
      </div>
    </div>
  );
}

// Telegram: медиа сверху, текст под ним, снизу — просмотры и время.
function TelegramPreview({
  on,
  text,
  media,
  typing,
  name,
  handle,
  subscribers,
  when,
}: PreviewProps & { handle: string }) {
  const shown = text.slice(0, TG_LIMIT);
  const cut = Math.max(0, text.length - TG_LIMIT);
  const views = subscribers > 0 ? Math.round(subscribers * 0.26) : null;

  return (
    <div>
      <PreviewHead network="tg" on={on} />
      <Card
        className={cn(
          "overflow-hidden rounded-lg p-0 transition-opacity duration-200",
          !on && "opacity-40",
        )}
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="h-9 w-9 shrink-0 rounded-full bg-brand-gradient" aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-bold text-text">{name}</p>
            <p className="truncate text-[13px] text-text-3">{handle}</p>
          </div>
        </div>

        {media && (
          <div className="px-3 pt-3">
            <MediaBlock media={media} className="h-32" />
          </div>
        )}

        <div className="px-4 py-3">
          <PreviewText value={shown} typing={typing} />
          {cut > 0 && (
            <p className="mt-2 text-[13px] font-medium text-danger">
              Telegram обрежет здесь — {chars(cut)} не поместились.
            </p>
          )}
        </div>

        <div className="flex items-center gap-1.5 border-t border-line px-4 py-2.5 text-[13px] text-text-3">
          {views != null && (
            <>
              <Eye className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              <span className="nums">{fmtCompact(views)}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span className="nums">{when}</span>
        </div>
      </Card>
    </div>
  );
}

// VK: текст сверху, вложение под ним, снизу — реакции.
function VkPreview({ on, text, media, typing, name, subscribers, when }: PreviewProps) {
  const hasMetrics = subscribers > 0;
  const likes = Math.round(subscribers * 0.021);
  const comments = Math.round(subscribers * 0.004);
  const shares = Math.round(subscribers * 0.0022);
  const views = Math.round(subscribers * 0.42);

  return (
    <div>
      <PreviewHead network="vk" on={on} />
      <Card className={cn("overflow-hidden p-0 transition-opacity duration-200", !on && "opacity-40")}>
        <div className="flex items-center gap-3 px-4 pt-4">
          <div className="h-10 w-10 shrink-0 rounded-xs bg-brand-gradient" aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-bold text-text">{name}</p>
            <p className="truncate text-[13px] text-text-3">{when}</p>
          </div>
        </div>

        <div className="px-4 py-3">
          <PreviewText value={text} typing={typing} />
        </div>

        {media && (
          <div className="px-4 pb-3">
            <MediaBlock media={media} className="h-36" />
          </div>
        )}

        <div className="flex items-center gap-4 border-t border-line px-4 py-2.5 text-[13px] text-text-3">
          {hasMetrics ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <Heart className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                <span className="nums">{fmtNum(likes)}</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <MessageCircle className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                <span className="nums">{fmtNum(comments)}</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Share2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                <span className="nums">{fmtNum(shares)}</span>
              </span>
              <span className="ml-auto inline-flex items-center gap-1.5">
                <Eye className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                <span className="nums">{fmtCompact(views)}</span>
              </span>
            </>
          ) : (
            <span>Метрики появятся после публикации</span>
          )}
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- СКЕЛЕТОН */

function ComposerSkeleton() {
  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <Card className="min-w-0 flex-1 space-y-5 p-5 sm:p-6">
        <div className="skeleton h-4 w-28" />
        <div className="skeleton h-64 w-full rounded-sm" />
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-9 w-32 rounded-[10px]" />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="skeleton h-12 w-[176px] rounded-xs" />
          <div className="skeleton h-12 w-[136px] rounded-xs" />
        </div>
        <div className="skeleton h-11 w-56 rounded-xs" />
      </Card>

      <aside className="w-full shrink-0 space-y-4 lg:w-[380px]">
        <div className="skeleton h-5 w-40" />
        <div className="skeleton h-60 w-full rounded-lg" />
        <div className="skeleton h-60 w-full rounded-md" />
      </aside>
    </div>
  );
}
