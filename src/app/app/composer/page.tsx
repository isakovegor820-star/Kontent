"use client";

// А5. Редактор поста (Приложение А). Главное действие — «Добавить в календарь».
// ТЗ 5.3: один пост адаптируется под обе сети перед публикацией.
// ТЗ 5.6: ИИ пишет/переписывает/сокращает с опорой на разведку (sourceRef → тренд/конкурент).
//
// Next 16: страница читает ?draft=, ?date=, ?time= через useSearchParams(), а он требует
// обёртки в <Suspense> — иначе билд падает на CSR bailout. Поэтому всё состояние формы
// живёт в ComposerPage (над Suspense), чтобы кнопка «Добавить в календарь» в шапке AppShell
// видела то же состояние, что и редактор. ComposerInner только читает параметры и рисует.

import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  Clock,
  Flame,
  History,
  ImageIcon,
  Layers3,
  ListEnd,
  MoreHorizontal,
  Redo2,
  RefreshCw,
  Scissors,
  Send,
  Sparkles,
  Trash2,
  TrendingUp,
  Undo2,
  Upload,
  Video,
  X,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { EditorialReviewPanel } from "@/components/app/editorial-review-panel";
import { useProjects } from "@/components/app/project-provider";
import { PostSettingsMenu } from "@/components/studio/post-settings-menu";
import {
  composerTrackingDraftSelection,
  composerTrackingHasInput,
  EMPTY_COMPOSER_TRACKING,
  type ComposerTrackingValue,
} from "@/components/app/tracking-builder";
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
import { H2, HelperText } from "@/components/ui/typography";
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
import {
  composerHydrationIdentity,
  composerReturnTarget,
  composerSource,
} from "@/lib/app-routes";
import {
  activeComposerNetworks,
  createDraftClientKey,
  createServerDraft,
  deleteServerDraft,
  DRAFT_AUTOSAVE_DELAY_MS,
  draftMatchesWrite,
  DraftRequestError,
  getServerDraft,
  isRecoverableLegacyDraft,
  resolveAcknowledgedDraftRevision,
  runSingleDraftSave,
  reusableAcknowledgedDraft,
  scheduleDraftAutosave,
  shouldAutosaveDraft,
  updateServerDraft,
} from "@/lib/draft-client";
import type {
  DraftAiValidation,
  DraftSaveState,
  DraftTrackingSelection,
  DraftWriteInput,
  ServerDraft,
} from "@/lib/draft-types";
import {
  acknowledgePendingDraft,
  findPendingDraft,
  listPendingDrafts,
  persistPendingDraft,
  projectDraftWorkspaceId,
  removePendingDraft,
  type PendingDraftRevision,
} from "@/lib/draft-outbox";
import { composerAiReviewState } from "@/lib/draft-review";
import {
  approvePersonalDraftForPublication,
  editorialErrorMessage,
  type ClientEditorialState,
} from "@/lib/editorial-client";
import { publicationOperationFailureFeedback } from "@/lib/publication-operation-feedback";
import { renderPublicationTracking } from "@/lib/publication-tracking";
import {
  DEFAULT_POST_SETTINGS,
  normalizePostSettings,
  type PostSettings,
} from "@/lib/post-settings";
import { buildTelegramPayload } from "@/lib/telegram-payload.mjs";
import {
  nextMoscowPublishingSlot,
  type BestPublishingTime,
} from "@/lib/best-publishing-time";
import {
  inspectLocalSchedule,
  resolveLocalSchedule,
  type ScheduleDisambiguation,
} from "@/lib/timezone-schedule";
import { useStore } from "@/lib/store";
import type { Network, Post, RealChannel } from "@/lib/types";
import {
  addDays,
  atTime,
  cn,
  fmtDateTime,
  fmtNum,
  fmtTime,
  plural,
} from "@/lib/utils";

/* ------------------------------------------------------------------ ХЕЛПЕРЫ */

const VK_LIMIT = 16384;

const NETWORK_ORDER: Network[] = ["tg", "vk"];

const toDateValue = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const toTimeValue = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function resolveComposerSchedule(
  date: string,
  time: string,
  timezone: string,
  disambiguation: ScheduleDisambiguation,
) {
  if (!date || !time) return null;
  try {
    return resolveLocalSchedule({
      localDate: date,
      localTime: time,
      timezone,
      disambiguation,
    });
  } catch {
    return null;
  }
}

function revealComposerProblem(errors: Errors) {
  const id = errors.text
    ? "composer-text"
    : errors.networks
      ? "composer-destinations"
      : errors.tracking
        ? "composer-protection"
        : "publication-time";
  const element = document.getElementById(id);
  if (!element) return;
  const details = element.closest("details") as HTMLDetailsElement | null;
  if (details) details.open = true;
  window.requestAnimationFrame(() => {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLButtonElement) {
      element.focus({ preventScroll: true });
    } else {
      element.querySelector<HTMLElement>("input, textarea, button, [tabindex]")?.focus({ preventScroll: true });
    }
  });
}

/** Заглушка медиа: цветной градиент по hue — файлы в демо не грузим. */
const mediaStyle = (hue: number) => ({
  backgroundImage: `linear-gradient(135deg, hsl(${hue} 88% 64%), hsl(${(hue + 46) % 360} 82% 48%))`,
});

const chars = (n: number) => `${fmtNum(n)} ${plural(n, "символ", "символа", "символов")}`;

function composerTrackingFromDraft(
  value: DraftTrackingSelection | null | undefined,
): ComposerTrackingValue {
  return value
    ? { ...value, templateId: null }
    : { ...EMPTY_COMPOSER_TRACKING, utmValues: {} };
}

function pendingComposerTracking(value: ComposerTrackingValue): DraftTrackingSelection | null {
  if (!composerTrackingHasInput(value)) return null;
  return {
    shortLinkId: value.shortLinkId,
    shortUrlPath: value.shortUrlPath,
    destination: value.destination,
    utmValues: { ...value.utmValues },
    placement: value.placement,
  };
}

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

type Errors = { text?: string; networks?: string; tracking?: string; when?: string };
type ComposerAiCommand = "write" | "rewrite" | "shorten" | "script";
type AiReviewState = "none" | "required" | "blocked";
type DraftPersistMode = "manual" | "autosave" | "schedule";
type PublicationMode = "calendar" | "now" | "queue";
type PublicationSuccess = {
  mode: PublicationMode;
  scheduledAt: string;
};
type ResolvedComposerSchedule = NonNullable<ReturnType<typeof resolveComposerSchedule>>;
type ComposerAiPreview = {
  text: string;
  phase: AiDraftPhase | null;
  status: "running" | "ready" | "interrupted";
  requestId?: string;
  validation?: DraftAiValidation | null;
  review?: AiReviewState;
  inputDraftVersion?: number | null;
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
  draftLoadError: "not_found" | "source_context" | null;
  editingId: string | null;
  draftId: number | null;
  draftVersion: number | null;
  editorialState: ClientEditorialState;
  onEditorialStateChange: (state: ClientEditorialState | null) => void;
  canEditContent: boolean;
  canPublish: boolean;
  canChangeSchedule: boolean;
  setDraftVersionFromPublicationSettings: (version: number) => void;
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
  channelIds: number[];
  setChannelId: (id: number) => void;
  toggleChannelId: (id: number) => void;
  /** В какое VK-сообщество уходит пост. null — сообществ нет или ещё грузятся. */
  vkChannelId: number | null;
  vkChannelIds: number[];
  setVkChannelId: (id: number) => void;
  toggleVkChannelId: (id: number) => void;
  media: Post["media"];
  setMedia: (m: Post["media"]) => void;
  tracking: ComposerTrackingValue;
  setTracking: (value: ComposerTrackingValue) => void;
  sourceRef: Post["sourceRef"];
  date: string;
  setDate: (v: string) => void;
  time: string;
  setTime: (v: string) => void;
  scheduleTimezone: string;
  timeDisambiguation: ScheduleDisambiguation;
  setTimeDisambiguation: (value: ScheduleDisambiguation) => void;
  noDate: boolean;
  setNoDate: (v: boolean) => void;
  aiBusy: ComposerAiCommand | null;
  typing: boolean;
  aiPreview: ComposerAiPreview | null;
  applyAiPreview: () => void;
  dismissAiPreview: () => void;
  aiReview: AiReviewState;
  topicOpen: boolean;
  setTopicOpen: (v: boolean) => void;
  topic: string;
  setTopic: (v: string) => void;
  errors: Errors;
  confirmDelete: boolean;
  setConfirmDelete: (v: boolean) => void;
  draftSaveState: DraftSaveState;
  draftSavedAt: string | null;
  postSettings: PostSettings;
  postSettingsSaving: boolean;
  savePostSettings: (value: PostSettings) => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  undoText: () => void;
  redoText: () => void;
  restoreRevision: (snapshot: Record<string, unknown>) => void;
  bestTime: BestPublishingTime | null;
  saving: boolean;
  publicationMode: PublicationMode | null;
  publicationSuccess: PublicationSuccess | null;
  clearPublicationSuccess: () => void;
  runAi: (cmd: ComposerAiCommand) => void;
  stopAi: () => void;
  quick: (kind: "hour" | "evening" | "tomorrow" | "best") => void;
  schedule: () => void;
  publishNow: () => void;
  enqueue: () => void;
  saveDraft: () => Promise<ServerDraft | null>;
  removeCurrent: () => Promise<void>;
  hydrate: (input: HydrateInput) => void;
  beginHydration: () => void;
  failHydration: (reason: "not_found" | "source_context") => void;
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
  const projects = useProjects();
  const router = useRouter();
  const composerUserId = s.user?.id ?? null;
  const currentProjectId = projects.current?.id ?? null;
  const projectRole = projects.current?.role ?? null;
  const canEditContent = projectRole != null && projectRole !== "publisher";
  const canPublish = projectRole === "owner" || projectRole === "publisher";
  const personalProject = projects.current?.personal === true;
  const draftWorkspaceId = currentProjectId == null ? null : projectDraftWorkspaceId(currentProjectId);

  const [hydrated, setHydrated] = useState(false);
  const [draftLoadError, setDraftLoadError] = useState<"not_found" | "source_context" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<number | null>(null);
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [editorialState, setEditorialState] = useState<ClientEditorialState>("draft");
  const [legacyId, setLegacyId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [networks, setNetworks] = useState<Network[]>([]);
  const [pickedIds, setPickedIds] = useState<number[] | null>(null);
  const [pickedVkIds, setPickedVkIds] = useState<number[] | null>(null);
  const [media, setMedia] = useState<Post["media"]>(null);
  const [tracking, setTracking] = useState<ComposerTrackingValue>(() => ({
    ...EMPTY_COMPOSER_TRACKING,
    utmValues: {},
  }));
  const [sourceRef, setSourceRef] = useState<Post["sourceRef"]>(undefined);
  const [origin, setOrigin] = useState<Post["origin"]>("manual");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [scheduleTimezone, setScheduleTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [timeDisambiguation, setTimeDisambiguation] = useState<ScheduleDisambiguation>("reject");
  const [noDate, setNoDate] = useState(false);
  const [aiBusy, setAiBusy] = useState<ComposerAiCommand | null>(null);
  const [typing, setTyping] = useState(false);
  const [aiPreview, setAiPreview] = useState<ComposerAiPreview | null>(null);
  const [aiReview, setAiReview] = useState<AiReviewState>("none");
  const [, setAiValidation] = useState<DraftAiValidation | null>(null);
  const [generationResultId, setGenerationResultId] = useState<number | null>(null);
  const [topicOpen, setTopicOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>("idle");
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [postSettings, setPostSettings] = useState<PostSettings>(() => DEFAULT_POST_SETTINGS);
  const [postSettingsSaving, setPostSettingsSaving] = useState(false);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const undoStackRef = useRef<string[]>([]);
  const redoStackRef = useRef<string[]>([]);
  const [publicationMode, setPublicationMode] = useState<PublicationMode | null>(null);
  const [publicationSuccess, setPublicationSuccess] = useState<PublicationSuccess | null>(null);
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
  const autosaveCancelRef = useRef<(() => void) | null>(null);
  const acknowledgedDraftRef = useRef<ServerDraft | null>(null);
  const scheduleRequestRef = useRef(false);
  const publicationOperationRef = useRef<{
    key: string;
    fingerprint: string | null;
    mode: PublicationMode;
  } | null>(null);
  const draftRevisionRef = useRef(0);
  const lastSavedRevisionRef = useRef(0);
  const lastAttemptedRevisionRef = useRef(0);
  const currentDraftWriteRef = useRef<DraftWriteInput | null>(null);
  const hydratedUserIdRef = useRef<number | null>(null);
  const textHistoryAtRef = useRef(0);

  useEffect(() => {
    if (!s.authReady || !s.user) return;
    const controller = new AbortController();
    void fetch("/api/settings", { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { postSettings?: unknown } | null) => {
        if (payload?.postSettings) setPostSettings(normalizePostSettings(payload.postSettings));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [s.authReady, s.user]);

  const savePostSettings = useCallback(async (value: PostSettings) => {
    const previous = postSettings;
    const next = normalizePostSettings(value);
    setPostSettings(next);
    setPostSettingsSaving(true);
    try {
      const response = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postSettings: next }),
      });
      if (!response.ok) throw new Error("settings_save_failed");
      const payload = await response.json().catch(() => null) as { postSettings?: unknown } | null;
      if (payload?.postSettings) setPostSettings(normalizePostSettings(payload.postSettings));
      s.toast({ kind: "success", title: "Настройки поста сохранены" });
    } catch {
      setPostSettings(previous);
      s.toast({
        kind: "danger",
        title: "Настройки не сохранены",
        body: "Вернули предыдущие значения. Проверь соединение и попробуй ещё раз.",
      });
    } finally {
      setPostSettingsSaving(false);
    }
  }, [postSettings, s]);

  const markDraftDirty = useCallback(() => {
    currentDraftWriteRef.current = null;
    draftRevisionRef.current += 1;
    setDraftRevision(draftRevisionRef.current);
    setDraftSaveState((state) => {
      if (state === "offline" || state === "conflict") return state;
      return "pending";
    });
    setDraftSavedAt(null);
    setEditorialState((state) => state === "approved" ? "draft" : state);
  }, []);

  const onEditorialStateChange = useCallback((state: ClientEditorialState | null) => {
    if (state) setEditorialState(state);
  }, []);
  const scheduleIsPublicationOverlay = canPublish && editorialState === "approved";
  const canChangeSchedule = canEditContent || scheduleIsPublicationOverlay;

  const setDraftVersionFromPublicationSettings = useCallback((version: number) => {
    if (!Number.isSafeInteger(version) || version <= 0) return;
    setDraftVersion(version);
    setEditorialState("draft");
    const acknowledged = acknowledgedDraftRef.current;
    if (acknowledged) {
      acknowledgedDraftRef.current = {
        ...acknowledged,
        version,
        human_review: null,
      };
    }
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
    setDraftLoadError(null);
    const fallback = new Date(Date.now() + 3600_000);
    fallback.setMinutes(0, 0, 0); // ровный час — по нему легче попадать глазом
    const when = post?.scheduledAt ? new Date(post.scheduledAt) : fallback;

    const existingMedia = pending?.payload.media ?? post?.media ?? null;
    const generatedMediaChanged = generatedMedia != null
      && JSON.stringify(generatedMedia) !== JSON.stringify(existingMedia);
    const initialRevision = (pending?.revision ?? 0) + (generatedMediaChanged ? 1 : 0);

    setEditingId(post?.id ?? null);
    setDraftId(draft?.id ?? pending?.draftId ?? null);
    setDraftVersion(draft?.version ?? pending?.baseVersion ?? null);
    setEditorialState(generatedMediaChanged || pending ? "draft" : draft?.editorial_state ?? "draft");
    setLegacyId(post && !draft ? post.id : null);
    draftRevisionRef.current = initialRevision;
    lastSavedRevisionRef.current = 0;
    lastAttemptedRevisionRef.current = 0;
    setDraftRevision(initialRevision);
    setLastSavedRevision(0);
    setLastAttemptedRevision(0);
    draftClientKeyRef.current = pending?.clientKey ?? draft?.client_key ?? null;
    acknowledgedDraftRef.current = draft ?? null;
    hydratedUserIdRef.current = ownerUserId;
    const pendingTgIds = pending?.form.channelIds.filter((id) =>
      s.realChannels.some((channel) => channel.id === id && channel.network === "tg" && channel.is_active),
    ) ?? [];
    const pendingVkIds = pending?.form.channelIds.filter((id) =>
      s.realChannels.some((channel) => channel.id === id && channel.network === "vk" && channel.is_active),
    ) ?? [];
    const draftTgIds = draft?.destinations
      .filter((destination) => destination.network === "tg")
      .map((destination) => destination.channel_id) ?? [];
    const draftVkIds = draft?.destinations
      .filter((destination) => destination.network === "vk")
      .map((destination) => destination.channel_id) ?? [];
    setPickedIds(pending ? pendingTgIds : draft ? draftTgIds : null);
    setPickedVkIds(pending ? pendingVkIds : draft ? draftVkIds : null);
    setText(pending?.payload.text ?? post?.text ?? "");
    undoStackRef.current = [];
    redoStackRef.current = [];
    setUndoStack([]);
    setRedoStack([]);
    textHistoryAtRef.current = 0;
    setPublicationSuccess(null);
    setPublicationMode(null);
    setNetworks(pending?.form.networks ?? (post?.networks?.length ? post.networks : (defaultNetworks ?? [])));
    setMedia(generatedMedia ?? pending?.payload.media ?? post?.media ?? null);
    setTracking(composerTrackingFromDraft(pending?.payload.tracking ?? draft?.tracking));
    setSourceRef(pending?.payload.sourceRef ?? post?.sourceRef);
    setOrigin(pending?.payload.origin ?? post?.origin ?? "manual");
    setAiPreview(null);
    setAiValidation(pending?.payload.aiValidation ?? draft?.ai_validation ?? null);
    // generationResultId is a one-shot token for a newly generated result that has not
    // been bound to a draft yet. A hydrated draft already owns its server-side lineage;
    // replaying that id on the next PATCH makes the server treat an ordinary edit as a
    // second generation attachment and correctly reject it with 422.
    setGenerationResultId(
      pending?.payload.generationResultId != null
      && pending.payload.generationResultId !== draft?.generation_result_id
        ? pending.payload.generationResultId
        : null,
    );
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
    setDate(pending?.form.date ?? draft?.scheduled_local_date ?? d ?? toDateValue(when));
    setTime(pending?.form.time ?? draft?.scheduled_local_time ?? t ?? toTimeValue(when));
    setScheduleTimezone(
      pending?.payload.schedule?.timezone
        ?? draft?.scheduled_timezone
        ?? Intl.DateTimeFormat().resolvedOptions().timeZone
        ?? "UTC",
    );
    setTimeDisambiguation(
      pending?.payload.schedule?.disambiguation
        ?? draft?.scheduled_disambiguation
        ?? "reject",
    );
    // «Без даты» — только явный выбор человека. Раньше любой загруженный черновик без
    // schedule автоматически попадал в очередь, а заполненные дата и время выглядели
    // сломанными. Новый черновик сразу готов к добавлению в календарь.
    // Queueing is now an explicit action in the sticky publication bar. Always keep
    // the calendar fields available when reopening an older undated draft.
    setNoDate(false);
    setDraftSaveState(
      generatedMediaChanged
        ? "pending"
        : pending
          ? pendingConflict ? "conflict" : "pending"
          : draft ? "saved" : "idle",
    );
    setDraftSavedAt(generatedMediaChanged || pending ? null : draft?.updated_at ?? null);
    setHydrated(true);
  }, [s.realChannels]);

  const beginHydration = useCallback(() => {
    autosaveCancelRef.current?.();
    autosaveCancelRef.current = null;
    setHydrated(false);
    setDraftLoadError(null);
  }, []);

  const failHydration = useCallback((reason: "not_found" | "source_context") => {
    acknowledgedDraftRef.current = null;
    draftClientKeyRef.current = null;
    setEditingId(null);
    setDraftId(null);
    setDraftVersion(null);
    setEditorialState("draft");
    setText("");
    undoStackRef.current = [];
    redoStackRef.current = [];
    setUndoStack([]);
    setRedoStack([]);
    setTracking({ ...EMPTY_COMPOSER_TRACKING, utmValues: {} });
    setSourceRef(undefined);
    setHydrated(false);
    setDraftLoadError(reason);
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
  const channelIds = useMemo(() => {
    if (pickedIds == null) return tgChannels[0] ? [tgChannels[0].id] : [];
    return pickedIds.filter((id) => tgChannels.some((channel) => channel.id === id));
  }, [pickedIds, tgChannels]);
  const vkChannelIds = useMemo(() => {
    if (pickedVkIds == null) return vkChannels[0] ? [vkChannels[0].id] : [];
    return pickedVkIds.filter((id) => vkChannels.some((channel) => channel.id === id));
  }, [pickedVkIds, vkChannels]);
  const channelId = channelIds[0] ?? null;
  const vkChannelId = vkChannelIds[0] ?? null;
  const currentDraftWrite = useMemo<DraftWriteInput>(() => {
    const schedule = noDate
      ? null
      : resolveComposerSchedule(date, time, scheduleTimezone, timeDisambiguation);
    return {
      text,
      media: media ?? null,
      scheduledAt: schedule?.scheduledAt ?? null,
      schedule: schedule
        ? {
            localDate: schedule.localDate,
            localTime: schedule.localTime,
            timezone: schedule.timezone,
            disambiguation: schedule.disambiguation,
            offset: schedule.offset,
          }
        : null,
      origin,
      sourceRef: sourceRef ?? null,
      channelIds: [
        ...(networks.includes("tg") ? channelIds : []),
        ...(networks.includes("vk") ? vkChannelIds : []),
      ],
      aiValidation: null,
      generationResultId: origin === "ai" ? generationResultId : null,
      tracking: composerTrackingDraftSelection(tracking).selection,
    };
  }, [
    channelIds,
    date,
    generationResultId,
    media,
    networks,
    noDate,
    origin,
    scheduleTimezone,
    sourceRef,
    text,
    time,
    timeDisambiguation,
    tracking,
    vkChannelIds,
  ]);
  useLayoutEffect(() => {
    currentDraftWriteRef.current = currentDraftWrite;
  }, [currentDraftWrite]);
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
      if (!canEditContent) return;
      const next = NETWORK_ORDER.filter((x) => (x === n ? on : networks.includes(x)));
      if (next.length === networks.length && next.every((item, index) => item === networks[index])) return;
      setNetworks(next);
      markDraftDirty();
      setErrors((e) => ({
        ...e,
        networks: next.length ? undefined : "Выбери хотя бы одну сеть — иначе посту некуда идти.",
      }));
    },
    [canEditContent, markDraftDirty, networks],
  );

  const changeText = useCallback((value: string) => {
    if (!canEditContent || value === text) return;
    const now = Date.now();
    if (now - textHistoryAtRef.current > 800) {
      const nextUndo = [...undoStackRef.current.slice(-49), text];
      undoStackRef.current = nextUndo;
      setUndoStack(nextUndo);
    }
    textHistoryAtRef.current = now;
    redoStackRef.current = [];
    setRedoStack([]);
    setText(value);
    if (origin === "ai") {
      setAiValidation(null);
      setAiReview("required");
      setGenerationResultId(null);
      setSourceRef(undefined);
    }
    markDraftDirty();
  }, [canEditContent, markDraftDirty, origin, text]);

  const undoText = useCallback(() => {
    if (!canEditContent || typing || undoStackRef.current.length === 0) return;
    const previous = undoStackRef.current[undoStackRef.current.length - 1];
    const nextUndo = undoStackRef.current.slice(0, -1);
    const nextRedo = [...redoStackRef.current.slice(-49), text];
    undoStackRef.current = nextUndo;
    redoStackRef.current = nextRedo;
    setUndoStack(nextUndo);
    setRedoStack(nextRedo);
    setText(previous);
    setOrigin("manual");
    setSourceRef(undefined);
    setAiValidation(null);
    setAiReview("none");
    setGenerationResultId(null);
    textHistoryAtRef.current = 0;
    markDraftDirty();
  }, [canEditContent, markDraftDirty, text, typing]);

  const redoText = useCallback(() => {
    if (!canEditContent || typing || redoStackRef.current.length === 0) return;
    const next = redoStackRef.current[redoStackRef.current.length - 1];
    const nextRedo = redoStackRef.current.slice(0, -1);
    const nextUndo = [...undoStackRef.current.slice(-49), text];
    redoStackRef.current = nextRedo;
    undoStackRef.current = nextUndo;
    setRedoStack(nextRedo);
    setUndoStack(nextUndo);
    setText(next);
    setOrigin("manual");
    setSourceRef(undefined);
    setAiValidation(null);
    setAiReview("none");
    setGenerationResultId(null);
    textHistoryAtRef.current = 0;
    markDraftDirty();
  }, [canEditContent, markDraftDirty, text, typing]);

  const restoreRevision = useCallback((snapshot: Record<string, unknown>) => {
    if (!canEditContent) return;
    const restoredText = typeof snapshot.text === "string" ? snapshot.text : "";
    if (!restoredText.trim()) return;
    const restoredChannelIds = Array.isArray(snapshot.channelIds)
      ? snapshot.channelIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
      : [];
    const restoredTgIds = restoredChannelIds.filter((id) =>
      s.realChannels.some((channel) => channel.id === id && channel.network === "tg" && channel.is_active),
    );
    const restoredVkIds = restoredChannelIds.filter((id) =>
      s.realChannels.some((channel) => channel.id === id && channel.network === "vk" && channel.is_active),
    );
    const restoredSchedule = snapshot.schedule && typeof snapshot.schedule === "object"
      ? snapshot.schedule as Record<string, unknown>
      : null;
    const nextUndo = [...undoStackRef.current.slice(-49), text];
    undoStackRef.current = nextUndo;
    redoStackRef.current = [];
    setUndoStack(nextUndo);
    setRedoStack([]);
    setText(restoredText);
    setMedia((snapshot.media ?? null) as Post["media"]);
    setTracking(composerTrackingFromDraft(snapshot.tracking as DraftTrackingSelection | null));
    setPickedIds(restoredTgIds);
    setPickedVkIds(restoredVkIds);
    setNetworks(NETWORK_ORDER.filter((network) => network === "tg" ? restoredTgIds.length > 0 : restoredVkIds.length > 0));
    setDate(typeof restoredSchedule?.localDate === "string" ? restoredSchedule.localDate : "");
    setTime(typeof restoredSchedule?.localTime === "string" ? restoredSchedule.localTime : "");
    setScheduleTimezone(
      typeof restoredSchedule?.timezone === "string"
        ? restoredSchedule.timezone
        : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    );
    setTimeDisambiguation(
      restoredSchedule?.disambiguation === "earlier" || restoredSchedule?.disambiguation === "later"
        ? restoredSchedule.disambiguation
        : "reject",
    );
    setNoDate(false);
    setOrigin("manual");
    setSourceRef(undefined);
    setAiValidation(null);
    setAiReview("none");
    setGenerationResultId(null);
    textHistoryAtRef.current = 0;
    markDraftDirty();
    s.toast({
      kind: "success",
      title: "Версия восстановлена",
      body: "Она стала новым изменением. Старые версии остались в истории.",
    });
  }, [canEditContent, markDraftDirty, s, text]);
  const changeNetworks = useCallback((value: Network[]) => {
    if (
      !canEditContent
      || (value.length === networks.length && value.every((item, index) => item === networks[index]))
    ) return;
    setNetworks(value);
    markDraftDirty();
  }, [canEditContent, markDraftDirty, networks]);
  const changeChannelId = useCallback((value: number) => {
    if (!canEditContent || (channelIds.length === 1 && channelIds[0] === value)) return;
    setPickedIds([value]);
    markDraftDirty();
  }, [canEditContent, channelIds, markDraftDirty]);
  const toggleChannelId = useCallback((value: number) => {
    if (!canEditContent) return;
    setPickedIds((current) => {
      const active = current ?? (tgChannels[0] ? [tgChannels[0].id] : []);
      return active.includes(value) ? active.filter((id) => id !== value) : [...active, value];
    });
    markDraftDirty();
  }, [canEditContent, markDraftDirty, tgChannels]);
  const changeVkChannelId = useCallback((value: number) => {
    if (!canEditContent || (vkChannelIds.length === 1 && vkChannelIds[0] === value)) return;
    setPickedVkIds([value]);
    markDraftDirty();
  }, [canEditContent, markDraftDirty, vkChannelIds]);
  const toggleVkChannelId = useCallback((value: number) => {
    if (!canEditContent) return;
    setPickedVkIds((current) => {
      const active = current ?? (vkChannels[0] ? [vkChannels[0].id] : []);
      return active.includes(value) ? active.filter((id) => id !== value) : [...active, value];
    });
    markDraftDirty();
  }, [canEditContent, markDraftDirty, vkChannels]);
  const changeMedia = useCallback((value: Post["media"]) => {
    if (!canEditContent || JSON.stringify(value ?? null) === JSON.stringify(media ?? null)) return;
    setMedia(value);
    markDraftDirty();
  }, [canEditContent, markDraftDirty, media]);
  const changeTracking = useCallback((value: ComposerTrackingValue) => {
    if (!canEditContent || JSON.stringify(value) === JSON.stringify(tracking)) return;
    setTracking(value);
    setErrors((current) => ({ ...current, tracking: undefined }));
    markDraftDirty();
  }, [canEditContent, markDraftDirty, tracking]);
  const changeDate = useCallback((value: string) => {
    if (!canChangeSchedule || saving || value === date) return;
    publicationOperationRef.current = null;
    setDate(value);
    setTimeDisambiguation("reject");
    if (!scheduleIsPublicationOverlay) markDraftDirty();
  }, [canChangeSchedule, date, markDraftDirty, saving, scheduleIsPublicationOverlay]);
  const changeTime = useCallback((value: string) => {
    if (!canChangeSchedule || saving || value === time) return;
    publicationOperationRef.current = null;
    setTime(value);
    setTimeDisambiguation("reject");
    if (!scheduleIsPublicationOverlay) markDraftDirty();
  }, [canChangeSchedule, markDraftDirty, saving, scheduleIsPublicationOverlay, time]);
  const changeTimeDisambiguation = useCallback((value: ScheduleDisambiguation) => {
    if (!canChangeSchedule || saving || value === timeDisambiguation) return;
    publicationOperationRef.current = null;
    setTimeDisambiguation(value);
    if (!scheduleIsPublicationOverlay) markDraftDirty();
  }, [canChangeSchedule, markDraftDirty, saving, scheduleIsPublicationOverlay, timeDisambiguation]);
  const changeNoDate = useCallback((value: boolean) => {
    if (!canEditContent || value === noDate) return;
    setNoDate(value);
    markDraftDirty();
  }, [canEditContent, markDraftDirty, noDate]);

  /* --------------------------------------------------------------------- ИИ */

  const stopAi = useCallback(() => {
    cancelRef.current?.();
  }, []);

  const runAi = useCallback(
    async (cmd: ComposerAiCommand) => {
      if (!canEditContent || typing || cancelRef.current) return;

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
          body: "Перепишу и сокращу то, что уже написано. Для пустого листа нажми «Написать».",
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
          inputDraftVersion: draftVersion,
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
          // Validation remains attached as internal telemetry, but every terminal
          // generated result is a ready post and must stay publishable.
          streamState.validation = "none";
        } else if (event.type === "error") {
          failed = true;
          updatePreview("interrupted");
          s.toast({
            kind: "danger",
            title: "ИИ не закончил текст",
            body: event.retryable
              ? "Связь с моделью прервалась. Исходный текст сохранён — можно повторить."
              : "Генерация не завершилась. Исходный текст сохранён — можно повторить.",
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
          inputDraftId: draftId,
          inputDraftVersion: draftVersion,
          postSettings,
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
            body: message,
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
              body: "Поток завершился без финального результата или проверки. Исходный текст сохранён.",
            });
          }
          return;
        }
        try {
          const acknowledged = await acknowledgeAiTerminal(aiRequest.key, { signal: controller.signal });
          setGenerationResultId(acknowledged.generationResultId);
        } catch (error) {
          if ((error as Error)?.name === "AbortError") throw error;
          setAiPreview({
            text: finalText,
            phase: projection.phase,
            status: "interrupted",
            requestId,
            inputDraftVersion: draftVersion,
          });
          s.toast({
            kind: "danger",
            title: "Ответ ещё не подтверждён",
            body: "Текст сохранён на сервере, но подтверждение не завершилось. Повтори тот же запрос — модель не будет вызвана заново.",
          });
          return;
        }
        setTopicOpen(false);
        setTopic("");
        setAiPreview({
          text: finalText,
          phase: projection.phase,
          status: "ready",
          requestId,
          validation: streamState.payload,
          review: streamState.validation,
          inputDraftVersion: draftVersion,
        });
        aiRequestRef.current = null;
      } catch (error) {
        updatePreview("interrupted");
        if ((error as Error)?.name !== "AbortError") {
          s.toast({
            kind: "danger",
            title: "Связь с ИИ прервалась",
            body: "Исходный текст сохранён. Попробуйте ещё раз.",
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
      canEditContent,
      channelId,
      draftId,
      draftVersion,
      networks,
      postSettings,
      s,
      text,
      topic,
      typing,
      vkChannelId,
    ],
  );

  const applyAiPreview = useCallback(() => {
    if (!canEditContent || !aiPreview?.text.trim() || aiPreview.status === "running") return;
    const hasTrustedGeneration = aiPreview.status === "ready"
      && generationResultId != null
      && aiPreview.inputDraftVersion === draftVersion;
    const nextUndo = [...undoStackRef.current.slice(-49), text];
    undoStackRef.current = nextUndo;
    redoStackRef.current = [];
    setUndoStack(nextUndo);
    setRedoStack([]);
    setText(aiPreview.text);
    setOrigin(hasTrustedGeneration ? "ai" : "manual");
    setAiValidation(hasTrustedGeneration ? aiPreview.validation ?? null : null);
    setAiReview(hasTrustedGeneration ? aiPreview.review ?? "required" : "none");
    if (!hasTrustedGeneration) setGenerationResultId(null);
    setAiPreview(null);
    textHistoryAtRef.current = 0;
    markDraftDirty();
  }, [aiPreview, canEditContent, draftVersion, generationResultId, markDraftDirty, text]);

  const dismissAiPreview = useCallback(() => {
    if (typing) return;
    setAiPreview(null);
    setGenerationResultId(null);
  }, [typing]);

  /* ------------------------------------------------------------------ ВРЕМЯ */

  const quick = useCallback((kind: "hour" | "evening" | "tomorrow" | "best") => {
    if (!canChangeSchedule || saving) return;
    publicationOperationRef.current = null;
    const now = new Date();
    let target: Date;

    if (kind === "hour") {
      target = new Date(now.getTime() + 3600_000);
      target.setSeconds(0, 0);
    } else if (kind === "evening") {
      target = atTime(now, "19:00");
      if (target.getTime() <= now.getTime()) target = atTime(addDays(now, 1), "19:00");
    } else if (kind === "tomorrow") {
      target = atTime(addDays(now, 1), "10:00");
    } else {
      if (!bestTime) return;
      target = nextMoscowPublishingSlot(bestTime.hour, now);
    }

    setNoDate(false);
    setDate(toDateValue(target));
    setTime(toTimeValue(target));
    setScheduleTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    setTimeDisambiguation("reject");
    if (!scheduleIsPublicationOverlay) markDraftDirty();
    setErrors((e) => ({ ...e, when: undefined }));
  }, [bestTime, canChangeSchedule, markDraftDirty, saving, scheduleIsPublicationOverlay]);

  /* ------------------------------------------------------------- СОХРАНЕНИЕ */

  const validate = useCallback(
    (needWhen: boolean) => {
      const next: Errors = {};

      if (typing || cancelRef.current) next.text = "Дождись финальной проверки ИИ или останови генерацию.";
      if (!text.trim()) next.text = "Пост пустой. Напиши что-нибудь или попроси ИИ.";
      if (!networks.length) next.networks = "Выбери хотя бы одну сеть — иначе посту некуда идти.";
      if (networks.includes("tg") && channelIds.length === 0) next.networks = "Выбери хотя бы один канал Telegram.";
      if (networks.includes("vk") && vkChannelIds.length === 0) next.networks = "Выбери хотя бы одно сообщество VK.";
      const trackingValidation = composerTrackingDraftSelection(tracking);
      if (trackingValidation.error) next.tracking = trackingValidation.error;
      if (
        needWhen
        && aiReview === "required"
        && editorialState !== "approved"
        && !personalProject
      ) {
        next.text = "Проверь факты в тексте ИИ и подтверди ручную проверку перед планированием.";
      }
      if (needWhen && aiReview === "blocked") {
        next.text = "Эта старая версия не привязана к завершённой генерации. Сохрани текст как новый пост.";
      }

      if (needWhen && noDate) {
        next.when = personalProject
          ? "Выбери дату и время, чтобы добавить пост в календарь."
          : "Выбери дату и время для согласованной публикации.";
      } else if (needWhen) {
        if (!date || !time) {
          next.when = "Поставь дату и время — или отметь «Без даты — в очередь».";
        } else {
          const inspected = inspectLocalSchedule({ localDate: date, localTime: time, timezone: scheduleTimezone });
          if (inspected.kind === "nonexistent") {
            next.when = "Такого местного времени нет из-за перехода на летнее время. Выбери другое.";
          } else if (inspected.kind === "ambiguous" && timeDisambiguation === "reject") {
            next.when = "Это время повторяется при переводе часов. Выбери первый или второй вариант.";
          } else if (inspected.kind === "invalid_timezone" || inspected.kind === "invalid_local_time") {
            next.when = "Дата, время или часовой пояс не распознаны.";
          }
        }
        const resolved = resolveComposerSchedule(date, time, scheduleTimezone, timeDisambiguation);
        if (resolved && Date.parse(resolved.scheduledAt) <= Date.now())
          next.when = "Это время уже прошло. Выбери будущее — или отправим в очередь без даты.";
      }

      setErrors(next);
      return next;
    },
    [aiReview, channelIds.length, date, editorialState, networks, noDate, personalProject, scheduleTimezone, text, time, timeDisambiguation, tracking, typing, vkChannelIds.length],
  );

  const persistDraft = useCallback(
    (
      mode: DraftPersistMode = "manual",
      publicationSchedule?: ResolvedComposerSchedule | null,
    ): Promise<ServerDraft | null> => {
      if (!canEditContent) return Promise.resolve(null);
      // setState асинхронен, поэтому одной disabled-кнопки недостаточно: два события в
      // одном кадре должны получить один и тот же Promise и один client_key.
      if (draftRequestRef.current) return draftRequestRef.current;

      const bad = validate(false);
      const first = bad.text ?? bad.networks ?? bad.tracking;
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
        const selectedTelegram = channelIds.filter((id) => tgChannels.some((channel) => channel.id === id));
        if (selectedTelegram.length > 0) {
          selected.push(...selectedTelegram);
        } else missing.push("Telegram");
      }
      if (networks.includes("vk")) {
        const selectedVk = vkChannelIds.filter((id) => vkChannels.some((channel) => channel.id === id));
        if (selectedVk.length > 0) {
          selected.push(...selectedVk);
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

      const hasPublicationSchedule = publicationSchedule !== undefined;
      const resolvedSchedule = hasPublicationSchedule
        ? publicationSchedule
        : noDate
          ? null
          : resolveComposerSchedule(date, time, scheduleTimezone, timeDisambiguation);
      if (!hasPublicationSchedule && !noDate && (date || time) && !resolvedSchedule) {
        const inspection = date && time
          ? inspectLocalSchedule({ localDate: date, localTime: time, timezone: scheduleTimezone })
          : null;
        const message = inspection?.kind === "nonexistent"
          ? "Такого времени нет из-за перевода часов. Выбери другое."
          : inspection?.kind === "ambiguous"
            ? "Выбери первый или второй вариант повторяющегося времени."
            : "Дата заполнена не полностью. Исправь её или выбери «Без даты».";
        setErrors((current) => ({ ...current, when: message }));
        setDraftSaveState("failed");
        if (mode !== "autosave") {
          s.toast({ kind: "danger", title: "Черновик не сохранён", body: message });
        }
        return Promise.resolve(null);
      }
      const scheduledAt = resolvedSchedule?.scheduledAt ?? null;
      const acknowledged = acknowledgedDraftRef.current;
      const currentDraftId = acknowledged?.id ?? draftId;
      const currentDraftVersion = acknowledged?.version ?? draftVersion;
      const unchanged = reusableAcknowledgedDraft({
        draft: acknowledged,
        draftId: currentDraftId,
        draftVersion: currentDraftVersion,
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
          const trackingSelection = composerTrackingDraftSelection(tracking).selection;
          const common = {
            text,
            media: media ?? null,
            scheduledAt,
            schedule: resolvedSchedule
              ? {
                  localDate: resolvedSchedule.localDate,
                  localTime: resolvedSchedule.localTime,
                  timezone: resolvedSchedule.timezone,
                  disambiguation: resolvedSchedule.disambiguation,
                  offset: resolvedSchedule.offset,
                }
              : null,
            origin,
            sourceRef: sourceRef ?? null,
            channelIds: selected,
            aiValidation: null,
            generationResultId: origin === "ai" ? generationResultId : null,
            tracking: trackingSelection,
          };
          const requestedWrite: DraftWriteInput = common;
          const clientKey = (draftClientKeyRef.current ??= createDraftClientKey());
          let draft: ServerDraft;
          if (currentDraftId != null && currentDraftVersion != null) {
            draft = await updateServerDraft(currentDraftId, { ...common, version: currentDraftVersion });
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
          // A field event can advance the revision before React commits the matching
          // form snapshot. Wait one frame only in that narrow window, then compare the
          // ACK with the actual rendered values instead of treating a missing snapshot
          // as a real concurrent edit.
          if (currentDraftWriteRef.current == null) {
            await new Promise<void>((resolve) => {
              window.requestAnimationFrame(() => resolve());
            });
          }
          const acknowledgedRevision = resolveAcknowledgedDraftRevision({
            draft,
            currentWrite: hasPublicationSchedule ? requestedWrite : currentDraftWriteRef.current,
            requestRevision: revisionAtStart,
            currentRevision: draftRevisionRef.current,
          });

          setDraftId(draft.id);
          setDraftVersion(draft.version);
          setEditorialState(draft.editorial_state ?? "draft");
          setOrigin(draft.origin);
          setSourceRef(draft.source_ref ?? undefined);
          setGenerationResultId(null);
          acknowledgedDraftRef.current = draft;
          setEditingId(`draft-${draft.id}`);
          draftClientKeyRef.current = draft.client_key;
          if (composerUserId != null) {
            // A newer local edit may already have replaced this record. Exact revision
            // matching prevents an older ACK from deleting that newer pending copy.
            acknowledgePendingDraft(composerUserId, clientKey, acknowledgedRevision.revision);
          }
          // Меняем адрес только после ACK сервера. Hard reload теперь восстановит именно
          // серверную версию; локальная legacy-копия при этом остаётся нетронутой.
          const nextParams = new URLSearchParams();
          nextParams.set("draft", String(draft.id));
          const safeSource = composerSource(new URLSearchParams(window.location.search).get("from"));
          if (safeSource) nextParams.set("from", safeSource);
          window.history.replaceState(null, "", `/app/composer?${nextParams.toString()}`);
          lastSavedRevisionRef.current = Math.max(lastSavedRevisionRef.current, acknowledgedRevision.revision);
          lastAttemptedRevisionRef.current = Math.max(lastAttemptedRevisionRef.current, acknowledgedRevision.revision);
          setLastSavedRevision((current) => Math.max(current, acknowledgedRevision.revision));
          setLastAttemptedRevision((current) => Math.max(current, acknowledgedRevision.revision));
          if (!acknowledgedRevision.current) {
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
      canEditContent,
      channelIds,
      composerUserId,
      date,
      draftId,
      draftVersion,
      generationResultId,
      legacyId,
      media,
      networks,
      noDate,
      origin,
      s,
      scheduleTimezone,
      sourceRef,
      text,
      tgChannels,
      time,
      timeDisambiguation,
      tracking,
      validate,
      vkChannelIds,
      vkChannels,
    ],
  );

  const currentSchedule = useMemo(
    () => noDate
      ? null
      : resolveComposerSchedule(date, time, scheduleTimezone, timeDisambiguation),
    [date, noDate, scheduleTimezone, time, timeDisambiguation],
  );
  const autosaveEligible = canEditContent && shouldAutosaveDraft({
    hydrated,
    revision: draftRevision,
    lastSavedRevision,
    lastAttemptedRevision,
    saveState: draftSaveState,
    hasText: Boolean(text.trim()),
    hasDestinations:
      networks.length > 0 &&
      networks.every((network) =>
        network === "tg" ? channelIds.length > 0 : network === "vk" ? vkChannelIds.length > 0 : false,
      ),
    scheduleValid: noDate || (!(date || time)) || Boolean(currentSchedule),
    busy: typing || saving,
  });

  // Durable write-through precedes the debounced network save. It intentionally records
  // incomplete form state too: a hard close immediately after a keystroke must not lose it.
  useEffect(() => {
    if (
      !canEditContent || !hydrated || composerUserId == null || draftWorkspaceId == null
      || hydratedUserIdRef.current !== composerUserId
      || draftRevision <= lastSavedRevision
    ) return;
    const clientKey = (draftClientKeyRef.current ??= createDraftClientKey());
    const selected = [
      ...(networks.includes("tg") ? channelIds : []),
      ...(networks.includes("vk") ? vkChannelIds : []),
    ];
    const durable = persistPendingDraft({
      schema: 1,
      userId: composerUserId,
      workspaceId: draftWorkspaceId,
      clientKey,
      draftId,
      baseVersion: draftVersion,
      revision: draftRevision,
      writtenAt: new Date().toISOString(),
      payload: {
        text,
        media: media ?? null,
        scheduledAt: currentSchedule?.scheduledAt ?? null,
        schedule: currentSchedule
          ? {
              localDate: currentSchedule.localDate,
              localTime: currentSchedule.localTime,
              timezone: currentSchedule.timezone,
              disambiguation: currentSchedule.disambiguation,
              offset: currentSchedule.offset,
            }
          : null,
        origin,
        sourceRef: sourceRef ?? null,
        channelIds: selected,
        aiValidation: null,
        generationResultId: origin === "ai" ? generationResultId : null,
        tracking: pendingComposerTracking(tracking),
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
    channelIds,
    canEditContent,
    composerUserId,
    date,
    draftId,
    draftRevision,
    draftVersion,
    draftWorkspaceId,
    hydrated,
    lastSavedRevision,
    media,
    networks,
    noDate,
    origin,
    currentSchedule,
    generationResultId,
    sourceRef,
    text,
    time,
    tracking,
    vkChannelIds,
  ]);

  useEffect(() => {
    if (!autosaveEligible) return;
    const revision = draftRevision;
    const cancel = scheduleDraftAutosave(() => {
      if (draftRevisionRef.current !== revision) return;
      void persistDraft("autosave");
    }, DRAFT_AUTOSAVE_DELAY_MS);
    autosaveCancelRef.current = cancel;
    return () => {
      cancel();
      if (autosaveCancelRef.current === cancel) autosaveCancelRef.current = null;
    };
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
    autosaveCancelRef.current?.();
    autosaveCancelRef.current = null;
    const acceptCurrentAcknowledgement = async (candidate: ServerDraft | null) => {
      if (!candidate) return null;
      if (currentDraftWriteRef.current == null) {
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
      }
      const acknowledged = resolveAcknowledgedDraftRevision({
        draft: candidate,
        currentWrite: currentDraftWriteRef.current,
        requestRevision: lastSavedRevisionRef.current,
        currentRevision: draftRevisionRef.current,
      });
      if (!acknowledged.current) return null;
      acknowledgedDraftRef.current = candidate;
      lastSavedRevisionRef.current = Math.max(lastSavedRevisionRef.current, acknowledged.revision);
      lastAttemptedRevisionRef.current = Math.max(lastAttemptedRevisionRef.current, acknowledged.revision);
      setLastSavedRevision((current) => Math.max(current, acknowledged.revision));
      setLastAttemptedRevision((current) => Math.max(current, acknowledged.revision));
      setDraftSaveState("saved");
      setDraftSavedAt(candidate.updated_at);
      return candidate;
    };
    const request = draftRequestRef.current;
    if (request) {
      const result = await request;
      const acknowledged = await acceptCurrentAcknowledgement(
        result ?? acknowledgedDraftRef.current,
      );
      if (acknowledged) return acknowledged;
    }
    const result = await persistDraft("manual");
    return result ?? await acceptCurrentAcknowledgement(acknowledgedDraftRef.current);
  }, [persistDraft]);

  const publish = useCallback(async (mode: PublicationMode) => {
    if (!canPublish) {
      s.toast({
        kind: "danger",
        title: "Нет права на публикацию",
        body: "Запланировать согласованный материал может владелец проекта или публикатор.",
      });
      return;
    }
    if (aiReview === "blocked") {
      s.toast({
        kind: "danger",
        title: "Пересохраните старую версию",
        body: "Эта версия не привязана к завершённой генерации. Сохраните текст как новый пост и повторите публикацию.",
      });
      return;
    }
    if (!personalProject && editorialState !== "approved") {
      s.toast({
        kind: "info",
        title: "Сначала согласуйте материал",
        body: "Планирование откроется после одобрения сохранённой версии.",
      });
      return;
    }
    if (scheduleRequestRef.current) return;
    scheduleRequestRef.current = true;
    const bad = validate(mode === "calendar");
    const first = bad.text ?? bad.networks ?? bad.tracking ?? bad.when;
    if (first) {
      s.toast({ kind: "danger", title: "Нужно заполнить данные", body: first });
      revealComposerProblem(bad);
      scheduleRequestRef.current = false;
      return;
    }

    setSaving(true);
    setPublicationMode(mode);
    setPublicationSuccess(null);
    try {
      let scheduleOverlay = mode === "calendar"
        ? resolveComposerSchedule(date, time, scheduleTimezone, timeDisambiguation)
        : null;
      if (mode !== "calendar") {
        const now = new Date();
        let target: Date;
        if (mode === "now") {
          target = new Date(now.getTime() + 120_000);
          target.setSeconds(0, 0);
        } else if (bestTime) {
          target = nextMoscowPublishingSlot(bestTime.hour, now);
        } else {
          target = new Date(now.getTime() + 3_600_000);
          target.setMinutes(0, 0, 0);
        }
        const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        scheduleOverlay = resolveComposerSchedule(
          toDateValue(target),
          toTimeValue(target),
          localTimezone,
          "reject",
        );
      }
      if (!scheduleOverlay) {
        s.toast({
          kind: "danger",
          title: "Время публикации не определено",
          body: "Выбери корректную дату или повтори действие.",
        });
        return;
      }

      // В личном проекте нажатие «Добавить в календарь» само является решением владельца
      // выпустить текущий текст. Сначала сохраняем именно видимую версию, затем без
      // дополнительной кнопки фиксируем её в том же versioned editorial-контракте,
      // который остаётся обязательным для командных проектов.
      let draft = personalProject
        ? await persistDraft("schedule", scheduleOverlay)
        : acknowledgedDraftRef.current;
      if (personalProject && draft) {
        await approvePersonalDraftForPublication(draft.id, draft.version);
        setEditorialState("approved");
        draft = { ...draft, editorial_state: "approved" };
        acknowledgedDraftRef.current = draft;
      }

      if (!draft) {
        s.toast({
          kind: "danger",
          title: personalProject ? "Черновик не сохранён" : "Версия не загружена",
          body: personalProject
            ? "Текст остался в редакторе. Исправь отмеченные поля или повтори сохранение."
            : "Открой материал из календаря заново. Согласованный текст не изменён.",
        });
        return;
      }
      if (publicationOperationRef.current?.mode !== mode) publicationOperationRef.current = null;
      const operation = (publicationOperationRef.current ??= {
        key: crypto.randomUUID(),
        fingerprint: null,
        mode,
      });
      const result = await s.createPublicationOperation({
        draftId: draft.id,
        draftVersion: draft.version,
        idempotencyKey: operation.key,
        operationFingerprint: operation.fingerprint,
        timezone: scheduleOverlay.timezone,
        schedule: scheduleOverlay,
      });
      if (result.fingerprint) operation.fingerprint = result.fingerprint;
      if (result.ok && result.operationStatus === "queued") {
        publicationOperationRef.current = null;
        router.push("/app/calendar");
        if (mode !== "calendar") {
          setDate(scheduleOverlay.localDate);
          setTime(scheduleOverlay.localTime);
          setScheduleTimezone(scheduleOverlay.timezone);
          setTimeDisambiguation(scheduleOverlay.disambiguation);
          setNoDate(false);
        }
        setPublicationSuccess({
          mode,
          scheduledAt: result.scheduledAt ?? scheduleOverlay.scheduledAt,
        });
        if (composerUserId != null && draftClientKeyRef.current) {
          removePendingDraft(composerUserId, draftClientKeyRef.current);
        }
        s.toast({
          kind: "success",
          title: mode === "now" ? "Публикация принята" : mode === "queue" ? "Пост поставлен в очередь" : "Пост добавлен в календарь",
          body: `${fmtDateTime(result.scheduledAt ?? scheduleOverlay.scheduledAt)}. Повторное нажатие не создаст дубликат.`,
        });
      } else {
        const feedback = publicationOperationFailureFeedback(result);
        s.toast({
          kind: "danger",
          title: feedback.title,
          body: feedback.body,
        });
      }
    } catch (error) {
      s.toast({
        kind: "danger",
        title: "Не удалось добавить пост в календарь",
        body: personalProject
          ? editorialErrorMessage(error)
          : "Сервер не подтвердил операцию. Черновик остался в редакторе — повтори попытку.",
      });
    } finally {
      setSaving(false);
      setPublicationMode(null);
      scheduleRequestRef.current = false;
    }
  }, [
    bestTime,
    canPublish,
    composerUserId,
    date,
    editorialState,
    aiReview,
    personalProject,
    persistDraft,
    router,
    s,
    scheduleTimezone,
    time,
    timeDisambiguation,
    validate,
  ]);

  const schedule = useCallback(() => {
    void publish("calendar");
  }, [publish]);
  const publishNow = useCallback(() => {
    void publish("now");
  }, [publish]);
  const enqueue = useCallback(() => {
    void publish("queue");
  }, [publish]);
  const clearPublicationSuccess = useCallback(() => {
    setPublicationSuccess(null);
  }, []);

  const removeCurrent = useCallback(async () => {
    if (!canEditContent || !editingId) return;
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
  }, [canEditContent, composerUserId, draftId, draftVersion, editingId, legacyId, router, s]);

  const value = useMemo<ComposerValue>(
    () => ({
      hydrated,
      draftLoadError,
      editingId,
      draftId,
      draftVersion,
      editorialState,
      onEditorialStateChange,
      canEditContent,
      canPublish,
      canChangeSchedule,
      text,
      setText: changeText,
      networks,
      setNetworks: changeNetworks,
      toggleNetwork,
      tgChannels,
      vkChannels,
      channelId,
      channelIds,
      setChannelId: changeChannelId,
      toggleChannelId,
      vkChannelId,
      vkChannelIds,
      setVkChannelId: changeVkChannelId,
      toggleVkChannelId,
      media,
      setMedia: changeMedia,
      tracking,
      setTracking: changeTracking,
      sourceRef,
      date,
      setDate: changeDate,
      time,
      setTime: changeTime,
      scheduleTimezone,
      timeDisambiguation,
      setTimeDisambiguation: changeTimeDisambiguation,
      noDate,
      setNoDate: changeNoDate,
      aiBusy,
      typing,
      aiPreview,
      applyAiPreview,
      dismissAiPreview,
      aiReview,
      topicOpen,
      setTopicOpen,
      topic,
      setTopic,
      errors,
      confirmDelete,
      setConfirmDelete,
      draftSaveState,
      draftSavedAt,
      postSettings,
      postSettingsSaving,
      savePostSettings,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      undoText,
      redoText,
      restoreRevision,
      bestTime,
      saving,
      publicationMode,
      publicationSuccess,
      clearPublicationSuccess,
      runAi,
      stopAi,
      quick,
      schedule,
      publishNow,
      enqueue,
      setDraftVersionFromPublicationSettings,
      saveDraft,
      removeCurrent,
      hydrate,
      beginHydration,
      failHydration,
    }),
    [
      aiBusy,
      aiPreview,
      aiReview,
      applyAiPreview,
      canChangeSchedule,
      canEditContent,
      canPublish,
      channelId,
      channelIds,
      changeChannelId,
      changeDate,
      changeMedia,
      changeTracking,
      changeNetworks,
      changeNoDate,
      changeText,
      changeTime,
      changeTimeDisambiguation,
      changeVkChannelId,
      toggleChannelId,
      toggleVkChannelId,
      confirmDelete,
      date,
      draftId,
      draftVersion,
      draftSavedAt,
      draftSaveState,
      postSettings,
      postSettingsSaving,
      savePostSettings,
      undoStack.length,
      redoStack.length,
      undoText,
      redoText,
      restoreRevision,
      editorialState,
      dismissAiPreview,
      bestTime,
      beginHydration,
      editingId,
      errors,
      failHydration,
      hydrate,
      hydrated,
      draftLoadError,
      media,
      networks,
      noDate,
      onEditorialStateChange,
      tgChannels,
      vkChannels,
      vkChannelId,
      vkChannelIds,
      quick,
      removeCurrent,
      runAi,
      saveDraft,
      scheduleTimezone,
      saving,
      publicationMode,
      publicationSuccess,
      clearPublicationSuccess,
      schedule,
      publishNow,
      enqueue,
      setDraftVersionFromPublicationSettings,
      sourceRef,
      stopAi,
      text,
      time,
      timeDisambiguation,
      tracking,
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
        subtitle="Создавай, оформляй и добавляй публикации в календарь."
      >
        <Suspense fallback={<ComposerSkeleton />}>
          <ComposerInner />
        </Suspense>
      </AppShell>
    </ComposerCtx.Provider>
  );
}

/* ---------------------------------------------------- БЛОКИ И ЗАЩИТА РЕДАКТОРА */

function EditorSection({
  id,
  title,
  summary,
  icon,
  error,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  icon: React.ReactNode;
  error?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      id={id}
      open={open || Boolean(error)}
      onToggle={(event) => {
        if (!error) setOpen(event.currentTarget.open);
      }}
      className={cn(
        "group scroll-mt-24 overflow-hidden rounded-sm border bg-surface",
        error ? "border-danger/40" : "border-line",
      )}
    >
      <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 marker:content-none focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xs bg-surface-inset text-text-2" aria-hidden>
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-bold text-text">{title}</span>
          <span className={cn("mt-0.5 block truncate text-[13px]", error ? "text-danger-text" : "text-text-3")}>
            {error || summary}
          </span>
        </span>
        <ChevronDown className="h-5 w-5 shrink-0 text-text-3 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
      </summary>
      <div className="border-t border-line px-4 py-4 sm:px-5">{children}</div>
    </details>
  );
}

type RevisionHistoryItem = {
  id: number;
  draftVersion: number;
  authorName?: string;
  snapshot: Record<string, unknown>;
  createdAt: string;
};

function RevisionHistoryPanel() {
  const c = useComposer();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState<RevisionHistoryItem[]>([]);

  const load = useCallback(async () => {
    if (!c.draftId) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/drafts/${c.draftId}/revisions`, { cache: "no-store" });
      const payload = await response.json().catch(() => null) as { revisions?: RevisionHistoryItem[] } | null;
      if (!response.ok || !payload?.revisions) throw new Error("history_unavailable");
      setItems(payload.revisions);
    } catch {
      setError("История временно недоступна. Текущий текст и локальная копия не затронуты.");
    } finally {
      setLoading(false);
    }
  }, [c.draftId]);

  if (!c.draftId) {
    return <p className="text-[13px] leading-relaxed text-text-3">Первая серверная версия появится после автосохранения.</p>;
  }
  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
        aria-expanded={open}
      >
        <History className="h-4 w-4" aria-hidden />
        {open ? "Скрыть историю" : "Открыть историю версий"}
      </Button>
      {open && (
        <div className="space-y-2" aria-live="polite">
          {loading ? (
            <p role="status" className="text-[13px] text-text-3">Загружаем сохранённые версии…</p>
          ) : error ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="flex-1 text-[13px] text-danger-text">{error}</p>
              <Button variant="ghost" size="sm" onClick={() => void load()}>Повторить</Button>
            </div>
          ) : items.length === 0 ? (
            <p className="text-[13px] text-text-3">Сохранённых версий пока нет.</p>
          ) : (
            <ol className="grid max-h-80 gap-2 overflow-y-auto pr-1" aria-label="История версий черновика">
              {items.map((item) => {
                const versionText = typeof item.snapshot.text === "string" ? item.snapshot.text : "";
                return (
                  <li key={item.id} className="rounded-xs border border-line bg-surface-2 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-[13px] font-bold text-text">Версия {item.draftVersion}</p>
                        <p className="text-[12px] text-text-3">
                          {fmtDateTime(item.createdAt)}{item.authorName ? ` · ${item.authorName}` : ""}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!c.canEditContent}
                        onClick={() => c.restoreRevision(item.snapshot)}
                      >
                        Восстановить
                      </Button>
                    </div>
                    <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-text-2">{versionText || "Пустая версия"}</p>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function ComposerActionBar() {
  const c = useComposer();
  const projects = useProjects();
  const personal = projects.current?.personal === true;
  const approved = (personal || c.editorialState === "approved") && c.aiReview !== "blocked";
  if (!c.canPublish) return null;
  const unavailable = !c.hydrated || c.draftSaveState === "saving" || c.typing || c.saving;
  return (
    <div className="fixed inset-x-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-30 lg:right-8 lg:left-[calc(260px+2rem)] lg:bottom-4">
      <div className="mx-auto w-full max-w-5xl rounded-md border border-line bg-surface/95 p-3 shadow-lift backdrop-blur-xl sm:p-4">
        {c.publicationSuccess ? (
          <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-success-soft text-success-text">
              <CheckCircle2 className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-bold text-text">
                {c.publicationSuccess.mode === "now"
                  ? "Публикация принята"
                  : c.publicationSuccess.mode === "queue"
                    ? "Пост поставлен в очередь"
                    : "Пост добавлен в календарь"}
              </p>
              <p className="text-[13px] text-text-3">{fmtDateTime(c.publicationSuccess.scheduledAt)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/app/calendar"><Button variant="solid" size="sm">Открыть календарь</Button></Link>
              <Link href="/app/composer"><Button variant="ghost" size="sm" onClick={c.clearPublicationSuccess}>Создать ещё пост</Button></Link>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 text-[13px]" aria-live="polite">
              <p className="font-semibold text-text">
                {approved ? "Готово к публикации" : c.aiReview === "blocked" ? "Нужно пересохранить версию" : "Нужно согласовать пост"}
              </p>
              <p className="truncate text-text-3">
                {c.draftSaveState === "offline"
                  ? "Нет сети — изменения защищены локальной копией"
                  : c.draftSaveState === "saving"
                    ? "Сохраняем изменения…"
                    : c.draftSaveState === "saved"
                      ? `Сохранено${c.draftSavedAt ? ` в ${fmtTime(c.draftSavedAt)}` : ""}`
                      : "Изменения сохраняются автоматически"}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:justify-end">
              <Button
                variant="brand"
                size="sm"
                className="col-span-2"
                disabled={unavailable}
                loading={c.publicationMode === "calendar"}
                onClick={c.schedule}
              >
                {c.publicationMode !== "calendar" && <CalendarClock className="h-4 w-4" aria-hidden />}
                Добавить в календарь
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={unavailable}
                loading={c.publicationMode === "now"}
                onClick={c.publishNow}
              >
                {c.publicationMode !== "now" && <Send className="h-4 w-4" aria-hidden />}
                <span className="sm:hidden">Сейчас</span>
                <span className="hidden sm:inline">Опубликовать сейчас</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={unavailable}
                loading={c.publicationMode === "queue"}
                onClick={c.enqueue}
              >
                {c.publicationMode !== "queue" && <ListEnd className="h-4 w-4" aria-hidden />}
                <span className="sm:hidden">В очередь</span>
                <span className="hidden sm:inline">Поставить в очередь</span>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- РЕДАКТОР */

function ComposerInner() {
  const s = useStore();
  const projects = useProjects();
  const router = useRouter();
  const params = useSearchParams();
  const reduce = useReducedMotion();
  const c = useComposer();
  const [publicOrigin, setPublicOrigin] = useState("");
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false);
  const [mediaLibraryLoading, setMediaLibraryLoading] = useState(false);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [mediaLibraryError, setMediaLibraryError] = useState("");
  const [mediaLibraryAssets, setMediaLibraryAssets] = useState<Array<{
    id: number;
    fileName: string;
    mimeType: string;
    url: string;
    origin: string;
  }>>([]);
  const uploadRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setPublicOrigin(window.location.origin), 0);
    return () => window.clearTimeout(timer);
  }, []);

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
  const mediaReturnSource = params.get("from") === "studio-visuals"
    ? composerSource(params.get("returnTo"))
    : null;
  const returnTarget = composerReturnTarget(
    mediaReturnSource ?? composerSource(params.get("from")),
    c.draftId ?? draftParam,
  );

  const {
    hydrate,
    beginHydration,
    failHydration,
    hydrated,
    draftLoadError,
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
  const currentProjectId = projects.current?.id ?? null;
  const canEditContent = c.canEditContent;
  const currentProjectPersonal = projects.current?.personal === true;
  const currentWorkspaceId = currentProjectId == null ? null : projectDraftWorkspaceId(currentProjectId);
  const toast = s.toast;

  // Pending outbox is selected before the server snapshot, so a hard reload never flashes
  // and then overwrites the newer local text with an older acknowledged version.
  useEffect(() => {
    if (!storeReady || !authReady || !realReady || !projects.ready || currentProjectId == null || !currentWorkspaceId) return;
    const key = composerHydrationIdentity({
      userId: currentUserId,
      projectId: currentProjectId,
      draftId: draftParam,
      legacyId: legacyParam,
      channelId: channelParam,
      date: dateParam,
      time: timeParam,
      fromMedia,
    });
    if (draftParam && currentDraftId === draftParam && hydrated && loadedKey.current === key) {
      loadedKey.current = key;
      return;
    }
    if (loadedKey.current === key) return;

    const controller = new AbortController();
    let cancelled = false;
    const defaultNetworks = activeComposerNetworks(realChannels);
    beginHydration();

    void (async () => {
      let draft: ServerDraft | null = null;
      let post: Post | null = null;
      const projectPending = currentUserId == null
        ? null
        : draftParam
          ? findPendingDraft(currentUserId, { draftId: draftParam }, undefined, currentWorkspaceId)
          : !legacyParam && !fromMedia
            ? listPendingDrafts(currentUserId, undefined, currentWorkspaceId)[0] ?? null
            : null;
      const pending = projectPending ?? (currentUserId != null && currentProjectPersonal
        ? draftParam
          ? findPendingDraft(currentUserId, { draftId: draftParam }, undefined, `personal:${currentUserId}`)
          : !legacyParam && !fromMedia
            ? listPendingDrafts(currentUserId, undefined, `personal:${currentUserId}`)[0] ?? null
            : null
        : null);
      if (draftParam) {
        try {
          draft = await getServerDraft(draftParam, controller.signal);
          if (draft.purpose === "source_context") {
            loadedKey.current = key;
            failHydration("source_context");
            return;
          }
          post = draftToPost(draft);
        } catch (error) {
          if (cancelled) return;
          if (!pending && error instanceof DraftRequestError && error.kind === "not_found") {
            loadedKey.current = key;
            failHydration("not_found");
            return;
          }
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
    beginHydration,
    channelParam,
    currentDraftId,
    currentProjectId,
    currentProjectPersonal,
    currentUserId,
    currentWorkspaceId,
    dateParam,
    draftParam,
    failHydration,
    fromMedia,
    hydrate,
    hydrated,
    legacyParam,
    authReady,
    localPosts,
    projects.ready,
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

  if (!s.ready) return <ComposerSkeleton />;
  if (draftLoadError === "source_context") {
    return (
      <Card className="py-6">
        <EmptyState
          icon={<Flame className="h-6 w-6" aria-hidden />}
          title="Это исходный материал, а не черновик публикации"
          body="Аврора хранит источник отдельно, чтобы чужой или сырой текст нельзя было случайно отправить в канал. Сначала создай самостоятельный материал в Студии."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link href={draftParam ? `/app/studio?draft=${draftParam}&intent=create` : "/app/studio"}>
                <Button variant="solid">Создать материал</Button>
              </Link>
              <Link href="/app/calendar"><Button variant="ghost">Вернуться в календарь</Button></Link>
            </div>
          }
        />
      </Card>
    );
  }
  if (draftLoadError === "not_found") {
    return (
      <Card className="py-6">
        <EmptyState
          icon={<Bookmark className="h-6 w-6" aria-hidden />}
          title="Черновик не найден"
          body="Его могли удалить или он принадлежит другому аккаунту. Пустой редактор не открыт, чтобы ты случайно не продолжил не тот материал."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link href="/app/calendar">
                <Button variant="solid">Вернуться в календарь</Button>
              </Link>
              <Link href={channelParam ? `/app/composer?channel=${channelParam}` : "/app/composer"}>
                <Button variant="ghost">Создать новый</Button>
              </Link>
            </div>
          }
        />
      </Card>
    );
  }
  if (!hydrated) return <ComposerSkeleton />;

  const trackingSelection = composerTrackingDraftSelection(c.tracking).selection;
  const publicationPreview = trackingSelection?.shortLinkId != null && !publicOrigin
    ? { mainText: text, firstCommentText: null, publicUrl: null }
    : renderPublicationTracking(text, trackingSelection, publicOrigin);
  const tgOn = c.networks.includes("tg");
  const vkOn = c.networks.includes("vk");
  const telegramPublicationPreview = publicationPreview;
  const vkPublicationPreview = publicationPreview;
  const previewText = tgOn ? telegramPublicationPreview.mainText : vkPublicationPreview.mainText;
  const len = previewText.length;
  const over = vkOn && vkPublicationPreview.mainText.length > VK_LIMIT;
  const telegramPreviewPayload = buildTelegramPayload({
    text: telegramPublicationPreview.mainText,
    hasAsset: Boolean(c.media),
  });
  const telegramMessageCount = telegramPreviewPayload.parts.filter(
    (part) => part.type === "text" || part.type === "media_caption",
  ).length;
  const aiUsage = getAiUsageMetrics(s.aiUsageStatus, s.aiUsed, s.aiLimit);
  const scheduleInspection = c.date && c.time
    ? inspectLocalSchedule({
        localDate: c.date,
        localTime: c.time,
        timezone: c.scheduleTimezone,
      })
    : null;

  const pickedCh = c.tgChannels.find((ch) => ch.id === c.channelId);
  const pickedVk = c.vkChannels.find((ch) => ch.id === c.vkChannelId);
  const aiContextDestination = tgOn ? pickedCh : vkOn ? pickedVk : null;

  const aiActions: { cmd: ComposerAiCommand; label: string; icon: React.ReactNode }[] = [
    { cmd: "write", label: "Написать", icon: <Sparkles className="h-4 w-4" aria-hidden /> },
    { cmd: "rewrite", label: "Улучшить", icon: <RefreshCw className="h-4 w-4" aria-hidden /> },
    { cmd: "shorten", label: "Сократить", icon: <Scissors className="h-4 w-4" aria-hidden /> },
  ];

  const openMediaLibrary = async () => {
    const nextOpen = !mediaLibraryOpen;
    setMediaLibraryOpen(nextOpen);
    if (!nextOpen || mediaLibraryAssets.length > 0) return;
    setMediaLibraryLoading(true);
    setMediaLibraryError("");
    try {
      const response = await fetch("/api/media/assets", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as { assets?: typeof mediaLibraryAssets } | null;
      if (!response.ok || !payload?.assets) throw new Error("media_library_unavailable");
      setMediaLibraryAssets(payload.assets);
    } catch {
      setMediaLibraryError("Медиатека не загрузилась. Проверь соединение и попробуй ещё раз.");
    } finally {
      setMediaLibraryLoading(false);
    }
  };

  const uploadMedia = async (file: File | null) => {
    if (!file || !canEditContent) return;
    setMediaUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("alt", "Изображение к публикации");
      const response = await fetch("/api/media/assets", { method: "POST", body: form });
      const payload = await response.json().catch(() => null) as {
        asset?: { id: number; fileName: string; mimeType: string; url: string; origin: string };
        error?: string;
      } | null;
      if (!response.ok || !payload?.asset) throw new Error(payload?.error || "upload_failed");
      c.setMedia({
        kind: "image",
        label: payload.asset.fileName,
        hue: 255,
        assetId: String(payload.asset.id),
        url: payload.asset.url,
        mimeType: payload.asset.mimeType,
      });
      setMediaLibraryAssets((assets) => [payload.asset!, ...assets.filter((asset) => asset.id !== payload.asset!.id)]);
      s.toast({ kind: "success", title: "Изображение добавлено" });
    } catch {
      s.toast({
        kind: "danger",
        title: "Изображение не загрузилось",
        body: "Подойдут JPG, PNG или WebP до 10 МБ.",
      });
    } finally {
      setMediaUploading(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (c.canPublish && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
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
      <nav aria-label="Возврат к предыдущему шагу">
        <Link
          href={returnTarget.href}
          className={cn(
            "inline-flex min-h-11 items-center gap-2 rounded-xs px-2 text-[14px] font-semibold text-text-2",
            "transition-colors duration-200 hover:bg-surface-inset hover:text-text",
            "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 motion-reduce:transition-none",
          )}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {returnTarget.label}
        </Link>
      </nav>

      <Card
        className="mx-auto w-full max-w-5xl min-w-0 space-y-6 p-5 sm:p-6"
      >
        {c.sourceRef && <SourcePlate source={c.sourceRef} />}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <H2>Текст поста</H2>
            <HelperText className="mt-0.5">Пиши сам или подготовь отдельный вариант с ИИ.</HelperText>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" disabled={!c.canUndo || !canEditContent} onClick={c.undoText} aria-label="Отменить изменение">
              <Undo2 className="h-[18px] w-[18px]" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" disabled={!c.canRedo || !canEditContent} onClick={c.redoText} aria-label="Вернуть изменение">
              <Redo2 className="h-[18px] w-[18px]" aria-hidden />
            </Button>
            <PostSettingsMenu
              value={c.postSettings}
              onChange={(value) => void c.savePostSettings(value)}
              network={tgOn && vkOn ? null : tgOn ? "tg" : vkOn ? "vk" : null}
              disabled={!canEditContent}
              saving={c.postSettingsSaving}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2" aria-label="Выбранные настройки поста">
          <Badge>{c.postSettings.length === "short" ? "Короткий" : c.postSettings.length === "long" ? "Длинный" : "Средний"}</Badge>
          <Badge>{c.postSettings.formality === "formal" ? "Официально" : c.postSettings.formality === "casual" ? "Неформально" : "Спокойный тон"}</Badge>
          <Badge>{c.postSettings.emojiMode === "none" ? "Без эмодзи" : "С эмодзи"}</Badge>
          <Badge>{c.postSettings.profanityMode === "allow" ? "Мат разрешён" : c.postSettings.profanityMode === "masked" ? "Мат со звёздочками" : c.postSettings.profanityMode === "forbid" ? "Без мата" : "Мат — автоматически"}</Badge>
        </div>

        <Field label="Текст публикации" htmlFor="composer-text" error={c.errors.text}>
          <div>
            <Textarea
              id="composer-text"
              ref={taRef}
              rows={7}
              value={text}
              readOnly={typing || !canEditContent}
              aria-busy={typing || undefined}
              onChange={(e) => c.setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Пиши как обычно — или нажми «Написать», и ИИ подготовит вариант."
              className={cn(
                "min-h-[180px] sm:min-h-[280px]",
                typing && "cursor-progress",
                !canEditContent && "cursor-default bg-surface-inset",
              )}
            />

            {!canEditContent && (
              <p role="status" className="mt-2 text-[13px] leading-relaxed text-text-2">
                Согласованный текст открыт только для чтения. Публикатор выбирает дату и отправляет именно эту версию.
              </p>
            )}

            <div className="mt-2 flex items-start justify-between gap-4">
              {over ? (
                <p className="text-[13px] font-medium text-danger">
                  Для VK лимит {fmtNum(VK_LIMIT)} символов — сократи текст.
                </p>
              ) : tgOn && telegramMessageCount > 1 ? (
                <p className="text-[13px] font-medium text-text-2">
                  Telegram отправит текст {telegramMessageCount} сообщениями.
                </p>
              ) : (
                <p className="text-[13px] text-text-3">
                  {c.canPublish ? "Ctrl + Enter — запланировать" : "Изменения сохраняются автоматически"}
                </p>
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
                  disabled={!canEditContent}
                  className="min-w-0 flex-1"
                  aria-label="Тема поста"
                />
                <Button variant="soft" disabled={!canEditContent} onClick={() => c.runAi("write")} className="shrink-0">
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
                disabled={!canEditContent || (typing && c.aiBusy !== a.cmd)}
                onClick={() => c.runAi(a.cmd)}
              >
                {c.aiBusy === a.cmd ? null : a.icon}
                {a.label}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="sm"
              loading={c.aiBusy === "script"}
              disabled={!canEditContent || (typing && c.aiBusy !== "script")}
              onClick={() => c.runAi("script")}
            >
              {c.aiBusy !== "script" && <MoreHorizontal className="h-4 w-4" aria-hidden />}
              Ещё: сценарий
            </Button>
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
                        : c.aiPreview.status === "ready"
                          ? "Вариант готов. Исходный текст не изменится, пока ты его не применишь."
                          : "Генерация остановлена. Готовая часть сохранена отдельно; исходный пост не изменён."}
                    </p>
                  </div>
                </div>
                <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-xs bg-surface px-3 py-2 text-[14px] leading-relaxed text-text">
                  {c.aiPreview.text}
                </div>
                {c.aiPreview.status !== "running" && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="soft" size="sm" onClick={c.applyAiPreview}>
                      {c.aiPreview.status === "ready" ? "Применить вариант" : "Использовать сохранённую часть"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={c.dismissAiPreview}>
                      Оставить текущий текст
                    </Button>
                  </div>
                )}
              </motion.section>
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

        {/* ------------------------------------------------------------ МЕДИА */}
        <EditorSection
          id="composer-media"
          title="Медиа"
          summary={c.media ? `Добавлено: ${c.media.label}` : "Без изображения или видео"}
          icon={<ImageIcon className="h-5 w-5" />}
        >
        <div className="space-y-3">

          <div className="flex flex-wrap gap-2">
            <input
              ref={uploadRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => void uploadMedia(event.target.files?.[0] ?? null)}
            />
            <Button variant="outline" size="sm" disabled={!canEditContent} loading={mediaUploading} onClick={() => uploadRef.current?.click()}>
              {!mediaUploading && <Upload className="h-4 w-4" aria-hidden />}
              Загрузить
            </Button>
            <Button variant="outline" size="sm" disabled={!canEditContent} aria-expanded={mediaLibraryOpen} onClick={() => void openMediaLibrary()}>
              <ImageIcon className="h-4 w-4" aria-hidden />
              {c.media?.kind === "image" ? "Заменить из медиатеки" : "Выбрать из медиатеки"}
            </Button>
            <Button variant="outline" size="sm" disabled={!canEditContent} onClick={() => {
              const returnSource = mediaReturnSource ?? composerSource(params.get("from"));
              const returnSuffix = returnSource ? `&returnTo=${returnSource}` : "";
              router.push(currentDraftId
                ? `/app/studio/visuals?draft=${currentDraftId}${returnSuffix}`
                : `/app/studio/visuals${returnSource ? `?returnTo=${returnSource}` : ""}`);
            }}>
              <Layers3 className="h-4 w-4" aria-hidden />
              Создать с ИИ
            </Button>
          </div>

          {mediaLibraryOpen && (
            <div className="rounded-sm border border-line bg-surface-2 p-3">
              <p className="text-[12px] font-bold tracking-wide text-text-3 uppercase">Медиатека проекта</p>
              {mediaLibraryLoading ? (
                <p role="status" className="mt-3 text-[13px] text-text-3">Загружаем изображения…</p>
              ) : mediaLibraryError ? (
                <p role="alert" className="mt-3 text-[13px] font-medium text-danger-text">{mediaLibraryError}</p>
              ) : mediaLibraryAssets.length === 0 ? (
                <p className="mt-3 text-[13px] text-text-3">Пока пусто. Создайте карусель или загрузите изображение в визуальной студии.</p>
              ) : (
                <div className="mt-3 flex snap-x gap-3 overflow-x-auto pb-2" role="list" aria-label="Изображения проекта">
                  {mediaLibraryAssets.map((asset) => (
                    <button
                      key={asset.id}
                      type="button"
                      role="listitem"
                      disabled={!canEditContent}
                      onClick={() => {
                        c.setMedia({ kind: "image", label: asset.fileName, hue: 255, assetId: String(asset.id), url: asset.url, mimeType: asset.mimeType });
                        setMediaLibraryOpen(false);
                      }}
                      className="w-32 shrink-0 snap-start rounded-xs border border-line bg-surface p-2 text-left hover:border-line-strong focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- authenticated project media cannot use the image optimizer */}
                      <img src={asset.url} alt="" className="aspect-square w-full rounded-[8px] object-cover" />
                      <span className="mt-2 block truncate text-[12px] font-semibold text-text">{asset.fileName}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

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
                  {c.media.kind === "image" && c.media.url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- authenticated project media cannot use the image optimizer
                    <img src={c.media.url} alt="" className="h-full w-full object-cover" />
                  ) : <span className="absolute inset-0 flex items-center justify-center text-white">
                    {c.media.kind === "video" ? (
                      <Video className="h-5 w-5" strokeWidth={2} />
                    ) : c.media.kind === "carousel" ? (
                      <Layers3 className="h-5 w-5" strokeWidth={2} />
                    ) : (
                      <ImageIcon className="h-5 w-5" strokeWidth={2} />
                    )}
                  </span>}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-text">{c.media.label}</p>
                  <p className="truncate text-[13px] text-text-3">
                    {c.media.kind === "video"
                      ? "Видео · размер подгоним под каждую сеть"
                      : c.media.kind === "carousel"
                        ? `Карусель · ${c.media.items.length} карточки · публикация альбомом в Telegram`
                        : "Изображение · размер подгоним под каждую сеть"}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Убрать медиа"
                  disabled={!canEditContent}
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
        </EditorSection>

        {/* ------------------------------------------------------------- СЕТИ */}
        <EditorSection
          id="composer-destinations"
          title="Куда публикуем"
          summary={[
            tgOn ? `Telegram · ${c.channelIds.length} ${plural(c.channelIds.length, "канал", "канала", "каналов")}` : "",
            vkOn ? `VK · ${c.vkChannelIds.length} ${plural(c.vkChannelIds.length, "сообщество", "сообщества", "сообществ")}` : "",
          ].filter(Boolean).join(" · ") || "Назначение не выбрано"}
          error={c.errors.networks}
          icon={<Send className="h-5 w-5" />}
          defaultOpen={Boolean(c.errors.networks)}
        >
        <div className="space-y-3">

          <div className="flex flex-wrap items-center gap-6">
            {(c.tgChannels.length > 0 || tgOn) && (
              <Checkbox
                id="net-tg"
                checked={tgOn}
                disabled={!canEditContent}
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
                disabled={!canEditContent}
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

          {tgOn && (c.tgChannels.length > 1 || c.channelId == null) && (
            <div className="space-y-2 pt-1">
              <p className="text-[13px] font-semibold text-text-2">Каналы Telegram</p>
              <p className="text-[12px] text-text-3">Можно выбрать несколько.</p>
              <div className="flex flex-wrap gap-2">
                {c.tgChannels.map((ch) => {
                  const on = c.channelIds.includes(ch.id);
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      disabled={!canEditContent}
                      onClick={() => c.toggleChannelId(ch.id)}
                      aria-pressed={on}
                      className={cn(
                        "inline-flex h-11 max-w-full items-center gap-2 rounded-xs px-3.5 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-60",
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
              <p className="text-[13px] font-semibold text-text-2">Сообщества VK</p>
              <p className="text-[12px] text-text-3">Можно выбрать несколько.</p>
              <div className="flex flex-wrap gap-2">
                {c.vkChannels.map((ch) => {
                  const on = c.vkChannelIds.includes(ch.id);
                  return (
                    <button
                      key={ch.id}
                      type="button"
                      disabled={!canEditContent}
                      onClick={() => c.toggleVkChannelId(ch.id)}
                      aria-pressed={on}
                      className={cn(
                        "inline-flex h-11 max-w-full items-center gap-2 rounded-xs px-3.5 enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-60",
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
        </EditorSection>

        {!currentProjectPersonal && (
          <>
            <Divider />

            <div id="editorial-readiness" className="scroll-mt-6">
              <EditorialReviewPanel
                projectId={projects.current?.id ?? null}
                draftId={c.draftId}
                role={projects.current?.role}
                draftSaveState={c.draftSaveState}
                disabled={c.typing || c.saving}
                onSaveDraft={c.saveDraft}
                onStateChange={c.onEditorialStateChange}
              />
            </div>
          </>
        )}

        {/* ------------------------------------------------------------ ВРЕМЯ */}
        <EditorSection
          id="publication-time"
          title="Дата и публикация"
          summary={c.date && c.time ? `${c.date.split("-").reverse().join(".")} · ${c.time} · ${c.scheduleTimezone}` : "Дата и время не выбраны"}
          error={c.errors.when}
          icon={<CalendarClock className="h-5 w-5" />}
          defaultOpen={Boolean(c.errors.when)}
        >
          <Field
            label="Когда добавить в календарь"
            error={c.errors.when}
            hint={currentProjectPersonal
              ? "Выберите время будущей публикации. После добавления пост появится в календаре."
              : canEditContent
                ? "Дата черновика входит в согласуемую версию."
                : "Дата хранится в задании на публикацию и не меняет согласованный текст."}
          >
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                type="date"
                value={c.date}
                disabled={c.saving || c.noDate || !c.canChangeSchedule}
                aria-label="Дата публикации"
                onChange={(e) => c.setDate(e.target.value)}
                className="w-[176px] nums"
              />
              <Input
                type="time"
                value={c.time}
                disabled={c.saving || c.noDate || !c.canChangeSchedule}
                aria-label="Время публикации"
                onChange={(e) => c.setTime(e.target.value)}
                className="w-[136px] nums"
              />
            </div>

            {!c.noDate && (
              <p className="text-[13px] text-text-3">
                Часовой пояс: <span className="font-medium text-text-2">{c.scheduleTimezone}</span>
              </p>
            )}
            {!c.noDate && scheduleInspection?.kind === "nonexistent" && (
              <p role="alert" className="text-[13px] font-medium text-danger-text">
                В этот момент часы переводятся вперёд, поэтому местного времени не существует.
              </p>
            )}
            {!c.noDate && scheduleInspection?.kind === "ambiguous" && (
              <fieldset className="rounded-sm border border-fire/30 bg-fire-soft p-3">
                <legend className="px-1 text-[13px] font-semibold text-text">
                  Это время повторяется — какой вариант выбрать?
                </legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {([
                    ["earlier", scheduleInspection.earlier.offset, "Первый раз"],
                    ["later", scheduleInspection.later.offset, "Второй раз"],
                  ] as const).map(([value, offset, label]) => (
                    <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xs border border-line bg-surface px-3 text-[13px] text-text">
                      <input
                        type="radio"
                        name="schedule-disambiguation"
                        value={value}
                        disabled={c.saving || !c.canChangeSchedule}
                        checked={c.timeDisambiguation === value}
                        onChange={() => c.setTimeDisambiguation(value)}
                      />
                      <span><b className="font-semibold">{label}</b> ({offset})</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="soft"
                size="sm"
                disabled={c.saving || c.noDate || !c.canChangeSchedule}
                onClick={() => c.quick("hour")}
              >
                <Clock className="h-4 w-4" aria-hidden />
                Через час
              </Button>
              <Button
                variant="soft"
                size="sm"
                disabled={c.saving || c.noDate || !c.canChangeSchedule}
                onClick={() => c.quick("evening")}
              >
                <Clock className="h-4 w-4" aria-hidden />
                Сегодня вечером
              </Button>
              <Button
                variant="soft"
                size="sm"
                disabled={c.saving || c.noDate || !c.canChangeSchedule}
                onClick={() => c.quick("tomorrow")}
              >
                <CalendarClock className="h-4 w-4" aria-hidden />
                Завтра утром
              </Button>
              {c.bestTime ? (
                <Button
                  variant="soft"
                  size="sm"
                  disabled={c.saving || c.noDate || !c.canChangeSchedule}
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
                  Лучшее время появится после 3 опубликованных постов с метриками.
                </p>
              )}
            </div>

            <p className="text-[13px] leading-relaxed text-text-3">
              Для публикации без ручной даты используйте кнопку «Поставить в очередь» в нижней панели.
            </p>
          </div>
          </Field>
        </EditorSection>

        {/* --------------------------------------------------------- ДЕЙСТВИЯ */}
        <EditorSection
          id="composer-protection"
          title="Сохранение и версии"
          summary={c.draftSaveState === "offline"
            ? "Защищено локально · ждём сеть"
            : c.draftSaveState === "saved"
              ? `Сохранено${c.draftSavedAt ? ` в ${fmtTime(c.draftSavedAt)}` : ""}`
              : c.draftSaveState === "saving"
                ? "Сохраняем на сервере…"
                : "Автосохранение включено"}
          icon={<History className="h-5 w-5" />}
        >
        <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {canEditContent && (
              <>
            <Button
              variant="primary"
              onClick={c.saveDraft}
              loading={c.draftSaveState === "saving"}
              disabled={c.saving || c.typing}
            >
              {c.draftSaveState === "saved" ? "Сохранено" : "Сохранить сейчас"}
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
              </>
            )}
            {canEditContent && c.editingId && (
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
            {!canEditContent ? (
              <p className="max-w-[360px] font-medium text-text-2">
                Согласованная версия защищена от изменений.
              </p>
            ) : c.draftSaveState === "saving" ? (
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

        <RevisionHistoryPanel />

        {c.errors.tracking && (
          <div className="flex flex-wrap items-center gap-3 rounded-xs border border-danger/30 bg-danger-soft p-3">
            <p role="alert" className="min-w-0 flex-1 text-[13px] font-medium text-danger-text">
              {c.errors.tracking}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => c.setTracking({ ...EMPTY_COMPOSER_TRACKING, utmValues: {} })}
            >
              Убрать старые метки
            </Button>
          </div>
        )}

        <AnimatePresence initial={false}>
          {canEditContent && c.confirmDelete && (
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
        </div>
        </EditorSection>
      </Card>

      <ComposerActionBar />
      <div aria-hidden className="h-40 sm:h-28" />

    </>
  );
}

/* ------------------------------------------------------- ПЛАШКА «ИЗ РАЗВЕДКИ» */

function SourcePlate({ source }: { source: NonNullable<Post["sourceRef"]> }) {
  const href = source.kind === "rss"
    ? "/app/rss?view=journal"
    : source.kind === "competitor"
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

/* ---------------------------------------------------------------- СКЕЛЕТОН */

function ComposerSkeleton() {
  return (
    <Card className="mx-auto w-full max-w-5xl min-w-0 space-y-5 p-5 sm:p-6">
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
  );
}
