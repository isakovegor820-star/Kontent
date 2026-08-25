"use client";

// Состояние платформы. Без бэкенда: localStorage + React Context.
// Публикация «исполняется сервером» — здесь это таймер, который двигает статусы постов,
// чтобы поведение из ТЗ (5.3, Б1, Б3) было видно вживую.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AppState,
  AutopilotSlot,
  Competitor,
  Network,
  Post,
  RealChannel,
  RealPost,
  Settings,
  Trend,
  User,
} from "./types";
import { seedState } from "./mock";
import {
  parseAiUsageResponse,
  startAiUsagePolling,
  type AiUsageStatus,
} from "./ai-usage-sync";
import {
  createWorkspaceRequestFence,
  isAbortError,
  parseServerSelectedProjectId,
  readWorkspaceState,
  removeWorkspaceState,
  workspaceIdentityKey,
  writeWorkspaceState,
  type ClientWorkspaceIdentity,
} from "./client-workspace-isolation";
import { uid } from "./utils";
import { appendToastStack, stableToastDedupeKey } from "./toast-stack";

type Toast = {
  id: string;
  kind: "success" | "danger" | "fire" | "info";
  title: string;
  body?: string;
  dedupeKey: string;
};

type ToastInput = Omit<Toast, "id" | "dedupeKey"> & { dedupeKey?: string };

interface StoreValue extends AppState {
  ready: boolean; // сервер подтвердил проект, его localStorage поднят (демо-данные)
  authReady: boolean; // /api/auth/me ответил — можно решать лендинг/платформа
  authError: boolean;
  toasts: Toast[];
  toast: (t: ToastInput) => void;
  dismissToast: (id: string) => void;

  /** Перечитать, кто вошёл, с сервера. Зовём после входа и при загрузке. */
  refreshAuth: () => Promise<void>;
  signOut: () => void;
  finishOnboarding: () => Promise<boolean>;

  /* --- Настоящий постинг (Д.3): каналы и посты из базы --- */
  realChannels: RealChannel[];
  realPosts: RealPost[];
  realReady: boolean;
  realError: boolean;
  refreshReal: () => Promise<void>;
  connectChannel: (handle: string) => Promise<{ ok: boolean; error?: string; title?: string }>;
  /** Подключить VK-сообщество по ключу доступа сообщества (право «Стена»). */
  connectVkChannel: (token: string) => Promise<{ ok: boolean; error?: string; title?: string }>;
  createRealPost: (input: {
    channelId: number;
    draftId: number;
    draftVersion: number;
    text: string;
    scheduledAt: string | null;
    media?: Post["media"];
  }) => Promise<{ ok: boolean; error?: string; postId?: number }>;
  createPublicationOperation: (input: {
    draftId: number;
    draftVersion: number;
    idempotencyKey: string;
    operationFingerprint?: string | null;
    timezone: string;
    schedule?: {
      scheduledAt: string;
      localDate: string;
      localTime: string;
      timezone: string;
      disambiguation: "reject" | "earlier" | "later";
      offset: string;
    } | null;
  }) => Promise<{
    ok: boolean;
    result?: "operation_not_created" | "partial" | "queued" | "conflict" | "worker_unavailable";
    error?: string;
    operationId?: number;
    operationStatus?: string;
    fingerprint?: string;
    scheduledAt?: string;
    destinations?: Array<{ postId: number; channelId: number; queueStatus: string }>;
  }>;
  retryRealPost: (id: number) => Promise<{ ok: boolean }>;

  /* --- ИИ-студия (Д.8): настоящий дневной лимит генераций --- */
  aiUsed: number;
  aiLimit: number;
  aiUsageStatus: AiUsageStatus;
  refreshAiUsage: () => Promise<void>;

  addPost: (p: Partial<Post> & { text: string }) => Post;
  updatePost: (id: string, patch: Partial<Post>) => void;
  removePost: (id: string) => void;
  retryPost: (id: string) => void;

  addCompetitor: (input: { name: string; handle: string; network: Network }) => void;
  removeCompetitor: (id: string) => void;

  trendToDraft: (t: Trend) => Post;

  approveSlot: (id: string) => void;
  approveAllSlots: () => void;
  rejectSlot: (id: string) => void;
  editSlot: (id: string, patch: Partial<AutopilotSlot>) => void;
  scheduleApproved: () => number;

  updateSettings: (patch: Partial<Settings>) => void;

  joinWaitlist: (contact: string) => void;
  reset: () => void;
}

const Ctx = createContext<StoreValue | null>(null);

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore должен вызываться внутри <StoreProvider>");
  return v;
}

// Пользователь с сервера (/api/auth/me) → форма User для интерфейса.
type ServerUser = {
  // PostgreSQL `bigint` may arrive through JSON as a string depending on the driver.
  id: number | string;
  tg_id: number | null;
  vk_id: number | null;
  email: string | null;
  name: string | null;
  avatar: string | null;
  onboarding_completed_at: string | null;
};

function mapUser(su: ServerUser): User {
  const provider: User["provider"] = su.tg_id ? "telegram" : su.vk_id ? "vk" : "email";
  return {
    id: Number(su.id),
    name: su.name || su.email?.split("@")[0] || "Ты",
    email: su.email || (su.tg_id ? `Telegram` : su.vk_id ? `VK` : ""),
    provider,
    onboarded: Boolean(su.onboarding_completed_at),
  };
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>(() => seedState());
  const [ready, setReady] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const [realChannels, setRealChannels] = useState<RealChannel[]>([]);
  const [realPosts, setRealPosts] = useState<RealPost[]>([]);
  const [realReady, setRealReady] = useState(false);
  const [realError, setRealError] = useState(false);
  const [aiUsed, setAiUsed] = useState(0);
  const [aiLimit, setAiLimit] = useState(30);
  const [aiUsageStatus, setAiUsageStatus] = useState<AiUsageStatus>("loading");

  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null);
  const workspaceRef = useRef<ClientWorkspaceIdentity | null>(null);
  const activeUserRef = useRef<User | null>(state.user);
  const authReadyRef = useRef(authReady);
  const stateRef = useRef(state);
  const projectChangeQueuedRef = useRef(false);
  const [selectedProjectFence] = useState(createWorkspaceRequestFence);
  const [realRequestFence] = useState(createWorkspaceRequestFence);
  const [aiUsageRequestFence] = useState(createWorkspaceRequestFence);

  const persistCurrentWorkspace = useCallback(() => {
    const identity = workspaceRef.current;
    if (!identity || typeof window === "undefined") return;
    try {
      writeWorkspaceState(window.localStorage, identity, stateRef.current);
    } catch {
      /* приватный режим — состояние продолжает жить только в памяти */
    }
  }, []);

  const beginWorkspaceTransition = useCallback(() => {
    persistCurrentWorkspace();
    selectedProjectFence.invalidate();
    realRequestFence.invalidate();
    aiUsageRequestFence.invalidate();
    workspaceRef.current = null;
    const currentUser = activeUserRef.current;
    setWorkspaceKey(null);
    setReady(false);
    setState({
      ...seedState(),
      onboarded: currentUser?.onboarded ?? false,
      user: currentUser,
    });
    setRealChannels([]);
    setRealPosts([]);
    setRealReady(false);
    setRealError(false);
    setAiUsed(0);
    setAiLimit(30);
    setAiUsageStatus("loading");
  }, [aiUsageRequestFence, persistCurrentWorkspace, realRequestFence, selectedProjectFence]);

  // Кто вошёл — спрашиваем сервер (сессия в cookie). Зовём при загрузке и после входа.
  const refreshAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { user: ServerUser | null } | null;
      if (!res.ok) throw new Error("auth_unavailable");
      const nextUser = data?.user ? mapUser(data.user) : null;
      const accountChanged = (activeUserRef.current?.id ?? null) !== (nextUser?.id ?? null);
      if (accountChanged) beginWorkspaceTransition();
      activeUserRef.current = nextUser;
      setAuthError(false);
      setState((current) => {
        if (!accountChanged) {
          return {
            ...current,
            onboarded: nextUser?.onboarded ?? false,
            user: nextUser,
          };
        }
        return {
          ...seedState(),
          onboarded: nextUser?.onboarded ?? false,
          user: nextUser,
        };
      });
      if (accountChanged && !nextUser) setReady(true);
    } catch {
      setAuthError(true);
    } finally {
      authReadyRef.current = true;
      setAuthReady(true);
    }
  }, [beginWorkspaceTransition]);

  useEffect(() => {
    // Загрузка сессии с сервера — side-effect; setState происходит внутри async-колбэка.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- запрос /api/auth/me при монтировании
    refreshAuth();
  }, [refreshAuth]);

  useEffect(() => {
    activeUserRef.current = state.user;
    stateRef.current = state;
  }, [state]);

  /* ------------------------------- НАСТОЯЩИЙ ПОСТИНГ (Д.3): каналы и посты */

  const refreshReal = useCallback(async () => {
    const identity = workspaceRef.current;
    if (!identity) return;
    const identityKey = workspaceIdentityKey(identity);
    const ticket = realRequestFence.start(identityKey);
    const isCurrent = () => {
      const current = workspaceRef.current;
      return realRequestFence.isCurrent(
        ticket,
        current ? workspaceIdentityKey(current) : null,
      );
    };
    try {
      const [chRes, poRes] = await Promise.all([
        fetch("/api/channels", { cache: "no-store", signal: ticket.signal }),
        fetch("/api/posts", { cache: "no-store", signal: ticket.signal }),
      ]);
      if (!chRes.ok || !poRes.ok) throw new Error("real_data_unavailable");
      const ch = (await chRes.json().catch(() => null)) as { channels?: RealChannel[] } | null;
      const po = (await poRes.json().catch(() => null)) as { posts?: RealPost[] } | null;
      if (!isCurrent()) return;
      setRealChannels(ch?.channels ?? []);
      setRealPosts(po?.posts ?? []);
      setRealError(false);
    } catch (error) {
      if (isAbortError(error) || !isCurrent()) return;
      /* сеть пропала — оставляем что было */
      setRealError(true);
    } finally {
      if (isCurrent()) setRealReady(true);
    }
  }, [realRequestFence]);

  const connectChannel = useCallback<StoreValue["connectChannel"]>(
    async (handle) => {
      try {
        const res = await fetch("/api/channels/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle }),
        });
        const data = (await res.json().catch(() => null)) as
          | { ok: boolean; error?: string; title?: string }
          | null;
        if (res.ok && data?.ok) {
          await refreshReal();
          return { ok: true, title: data.title };
        }
        return { ok: false, error: data?.error };
      } catch {
        return { ok: false, error: "network" };
      }
    },
    [refreshReal],
  );

  const connectVkChannel = useCallback<StoreValue["connectVkChannel"]>(
    async (token) => {
      try {
        const res = await fetch("/api/channels/connect-vk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const data = (await res.json().catch(() => null)) as
          | { ok: boolean; error?: string; title?: string }
          | null;
        if (res.ok && data?.ok) {
          await refreshReal();
          return { ok: true, title: data.title };
        }
        return { ok: false, error: data?.error };
      } catch {
        return { ok: false, error: "network" };
      }
    },
    [refreshReal],
  );

  const createRealPost = useCallback<StoreValue["createRealPost"]>(
    async ({ channelId, draftId, draftVersion, text, scheduledAt, media }) => {
      try {
        const idempotencyKey = globalThis.crypto.randomUUID();
        const res = await fetch("/api/posts/create", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
            channelId,
            draftId,
            draftVersion,
            text,
            scheduledAt,
            media,
            idempotencyKey,
          }),
        });
        const data = (await res.json().catch(() => null)) as
          | { ok: boolean; error?: string; postId?: number }
          | null;
        if (res.ok && data?.ok) {
          await refreshReal();
          return { ok: true, postId: data.postId };
        }
        return { ok: false, error: data?.error };
      } catch {
        return { ok: false, error: "network" };
      }
    },
    [refreshReal],
  );

  const createPublicationOperation = useCallback<StoreValue["createPublicationOperation"]>(
    async ({ draftId, draftVersion, idempotencyKey, operationFingerprint, timezone, schedule }) => {
      try {
        const response = await fetch("/api/publication-operations", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ draftId, draftVersion, operationFingerprint, timezone, schedule }),
        });
        const data = (await response.json().catch(() => null)) as
          | {
              ok?: boolean;
              result?: "operation_not_created" | "partial" | "queued" | "conflict" | "worker_unavailable";
              error?: string;
              operationId?: number;
              operationStatus?: string;
              fingerprint?: string;
              scheduledAt?: string;
              destinations?: Array<{ postId: number; channelId: number; queueStatus: string }>;
            }
          | null;
        if (data) {
          if (response.ok || data.operationId != null) await refreshReal();
          return { ...data, ok: response.ok && data.ok === true };
        }
        return { ok: false, result: "operation_not_created", error: "invalid_response" };
      } catch {
        return { ok: false, result: "operation_not_created", error: "network" };
      }
    },
    [refreshReal],
  );

  const retryRealPost = useCallback<StoreValue["retryRealPost"]>(
    async (id) => {
      try {
        const res = await fetch(`/api/posts/${id}/retry`, {
          method: "POST",
          headers: { "idempotency-key": globalThis.crypto.randomUUID() },
        });
        await refreshReal();
        return { ok: res.ok };
      } catch {
        return { ok: false };
      }
    },
    [refreshReal],
  );

  /* ---------------------------- ИИ-студия (Д.8): реальный дневной лимит */

  const refreshAiUsage = useCallback(async () => {
    const identity = workspaceRef.current;
    if (!identity) return;
    const identityKey = workspaceIdentityKey(identity);
    const ticket = aiUsageRequestFence.start(identityKey);
    const isCurrent = () => {
      const current = workspaceRef.current;
      return aiUsageRequestFence.isCurrent(
        ticket,
        current ? workspaceIdentityKey(current) : null,
      );
    };
    try {
      const r = await fetch("/api/ai/usage", { cache: "no-store", signal: ticket.signal });
      const parsed = parseAiUsageResponse(r.ok, await r.json().catch(() => null));
      if (!isCurrent()) return;
      if (parsed.status === "ok") {
        setAiUsed(parsed.used);
        setAiLimit(parsed.limit);
      }
      setAiUsageStatus(parsed.status);
    } catch (error) {
      if (isAbortError(error) || !isCurrent()) return;
      // Keep the last confirmed number internally, but do not present it as current fact.
      setAiUsageStatus("unknown");
    }
  }, [aiUsageRequestFence]);

  const resolveSelectedWorkspace = useCallback(async (expectedUserId: number) => {
    const requestScope = `user:${expectedUserId}:current-project`;
    const ticket = selectedProjectFence.start(requestScope);
    const isCurrent = () => (
      selectedProjectFence.isCurrent(ticket, requestScope)
      && activeUserRef.current?.id === expectedUserId
    );
    try {
      const response = await fetch("/api/projects/current", {
        cache: "no-store",
        signal: ticket.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      const projectId = response.ok ? parseServerSelectedProjectId(body) : null;
      if (!projectId) throw new Error("project_context_unavailable");
      if (!isCurrent()) return;

      const identity: ClientWorkspaceIdentity = { userId: expectedUserId, projectId };
      const loaded = typeof window === "undefined"
        ? null
        : readWorkspaceState(window.localStorage, identity);
      if (!isCurrent()) return;

      workspaceRef.current = identity;
      setWorkspaceKey(workspaceIdentityKey(identity));
      setState((current) => {
        if (current.user?.id !== expectedUserId) return current;
        return {
          ...(loaded ?? seedState()),
          onboarded: current.user.onboarded,
          user: current.user,
        };
      });
      setReady(true);
    } catch (error) {
      if (isAbortError(error) || !isCurrent()) return;
      workspaceRef.current = null;
      setWorkspaceKey(null);
      setState((current) => ({
        ...seedState(),
        onboarded: current.user?.onboarded ?? false,
        user: current.user,
      }));
      setReady(true);
      setRealReady(true);
      setRealError(true);
      setAiUsageStatus("unknown");
    }
  }, [selectedProjectFence]);

  const activeUserId = state.user?.id ?? null;

  // Выбор проекта всегда перечитываем с сервера. projectId из DOM-события — только
  // сигнал об изменении, но никогда не источник полномочий или ключа localStorage.
  useEffect(() => {
    const onProjectChanged = () => {
      projectChangeQueuedRef.current = true;
      beginWorkspaceTransition();
      const user = activeUserRef.current;
      if (!authReadyRef.current || !user) return;
      projectChangeQueuedRef.current = false;
      void resolveSelectedWorkspace(user.id);
    };
    window.addEventListener("aurora:project-changed", onProjectChanged);
    return () => window.removeEventListener("aurora:project-changed", onProjectChanged);
  }, [beginWorkspaceTransition, resolveSelectedWorkspace]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || !authReady) return;
      const user = activeUserRef.current;
      if (!user) {
        projectChangeQueuedRef.current = false;
        setReady(true);
        return;
      }
      projectChangeQueuedRef.current = false;
      void resolveSelectedWorkspace(user.id);
    });
    return () => { cancelled = true; };
  }, [activeUserId, authReady, resolveSelectedWorkspace]);

  // Реальные данные и счётчик ИИ начинают обновляться только после подтверждённой
  // сервером workspace identity. Смена workspace сначала очищает предыдущий экран.
  useEffect(() => {
    if (!workspaceKey) return;
    void refreshReal();
    void refreshAiUsage();
    const realTimer = setInterval(refreshReal, 8000);
    const stopAiUsagePolling = startAiUsagePolling(refreshAiUsage);
    return () => {
      clearInterval(realTimer);
      stopAiUsagePolling();
    };
  }, [workspaceKey, refreshReal, refreshAiUsage]);

  useEffect(() => {
    const identity = workspaceRef.current;
    if (!ready || !workspaceKey || !identity) return;
    try {
      writeWorkspaceState(window.localStorage, identity, state);
    } catch {
      /* приватный режим — молча живём в памяти */
    }
  }, [state, ready, workspaceKey]);

  useEffect(() => {
    const t = timers.current;
    return () => {
      t.forEach(clearTimeout);
      t.clear();
    };
  }, []);

  const toast = useCallback((t: ToastInput) => {
    const id = uid("t");
    const next = { ...t, id, dedupeKey: stableToastDedupeKey(t) };
    setToasts((prev) => appendToastStack(prev, next));
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const patch = useCallback((fn: (s: AppState) => AppState) => {
    setState((s) => fn(s));
  }, []);

  /* ------------------------------------------------------------ ВХОД */

  // Выход: оптимистично убираем пользователя сразу, сессию на сервере гасим в фоне.
  const signOut = useCallback(() => {
    beginWorkspaceTransition();
    activeUserRef.current = null;
    setState({ ...seedState(), user: null, onboarded: false });
    setReady(true);
    fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  }, [beginWorkspaceTransition]);

  const finishOnboarding = useCallback<StoreValue["finishOnboarding"]>(
    async () => {
      try {
        const response = await fetch("/api/onboarding/complete", { method: "POST" });
        const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
        if (!response.ok || !body?.ok) return false;
        patch((s) => ({
          ...s,
          onboarded: true,
          user: s.user ? { ...s.user, onboarded: true } : s.user,
        }));
        return true;
      } catch {
        return false;
      }
    },
    [patch],
  );

  /* ----------------------------------------------------------- ПОСТЫ */

  const addPost = useCallback<StoreValue["addPost"]>(
    (p) => {
      const post: Post = {
        id: uid("post"),
        legacyOwnerUserId: state.user?.id,
        text: p.text,
        networks: p.networks ?? ["tg", "vk"],
        scheduledAt: p.scheduledAt ?? null,
        status: p.status ?? (p.scheduledAt ? "scheduled" : "draft"),
        origin: p.origin ?? "manual",
        sourceRef: p.sourceRef,
        media: p.media ?? null,
        createdAt: new Date().toISOString(),
        attempts: 0,
      };
      patch((s) => ({ ...s, posts: [post, ...s.posts] }));
      return post;
    },
    [patch, state.user?.id],
  );

  const updatePost = useCallback<StoreValue["updatePost"]>(
    (id, p) =>
      patch((s) => ({
        ...s,
        posts: s.posts.map((x) => (x.id === id ? { ...x, ...p } : x)),
      })),
    [patch],
  );

  const removePost = useCallback<StoreValue["removePost"]>(
    (id) => patch((s) => ({ ...s, posts: s.posts.filter((x) => x.id !== id) })),
    [patch],
  );

  // Сбой → повтор. Показываем механику из ТЗ 5.3 честно: «публикуем» → успех.
  const retryPost = useCallback<StoreValue["retryPost"]>(
    (id) => {
      updatePost(id, { status: "publishing" });
      toast({
        kind: "info",
        title: "Отправляем ещё раз",
        body: "Ничего делать не нужно — сообщим, как только пост уйдёт.",
      });
      const timer = setTimeout(() => {
        updatePost(id, {
          status: "published",
          attempts: 4,
          failReason: undefined,
          metrics: { views: 0, reactions: 0, comments: 0, shares: 0 },
        });
        toast({
          kind: "success",
          title: "Пост вышел",
          body: "Ушёл в Telegram и VK. Цифры пришлём вечером.",
        });
        timers.current.delete(timer);
      }, 2200);
      timers.current.add(timer);
    },
    [updatePost, toast],
  );

  /* ----------------------------------------------------- КОНКУРЕНТЫ */

  const addCompetitor = useCallback<StoreValue["addCompetitor"]>(
    ({ name, handle, network }) => {
      const id = uid("cmp");
      const fresh: Competitor = {
        id,
        name,
        handle,
        network,
        avatarHue: Math.floor(Math.random() * 360),
        subscribers: 0,
        growth30d: 0,
        postsPerWeek: 0,
        er: 0,
        medianViews: 0,
        adSigns: 0,
        aiVerdict: "",
        topFormats: [],
        topTopics: [],
        mentions: [],
        bestPosts: [],
        reachSeries: [],
        addedAt: new Date().toISOString(),
        dossierStatus: "collecting",
      };
      patch((s) => ({ ...s, competitors: [fresh, ...s.competitors] }));
      toast({
        kind: "info",
        title: "Собираем досье",
        body: "Обычно занимает до часа. Напишем в бот, когда будет готово.",
      });

      // Демо: досье «собирается» за 6 секунд, а не за час
      const timer = setTimeout(() => {
        patch((s) => ({
          ...s,
          competitors: s.competitors.map((c) =>
            c.id === id
              ? {
                  ...c,
                  dossierStatus: "ready",
                  subscribers: 4200 + Math.floor(Math.random() * 30000),
                  growth30d: Number((Math.random() * 20 - 2).toFixed(1)),
                  postsPerWeek: 3 + Math.floor(Math.random() * 10),
                  er: Number((3 + Math.random() * 7).toFixed(1)),
                  medianViews: 1500 + Math.floor(Math.random() * 8000),
                  adSigns: Math.floor(Math.random() * 4),
                  aiVerdict:
                    "Досье собрано по открытым данным. Основной рост даёт короткое видео — у этого формата вовлечённость вдвое выше их среднего. Тексты без медиа проседают, повторять их не стоит.",
                  topFormats: [
                    { name: "Короткое видео", share: 42, er: 10.4 },
                    { name: "Фото + текст", share: 31, er: 5.9 },
                    { name: "Текст", share: 27, er: 2.8 },
                  ],
                  topTopics: [
                    { name: "Практика и разборы", share: 39, lift: 2.6 },
                    { name: "Личное", share: 33, lift: 1.9 },
                    { name: "Новости", share: 28, lift: 0.7 },
                  ],
                  mentions: [],
                  bestPosts: [
                    {
                      id: uid("cp"),
                      text: "Разбор ошибки, которую совершают почти все — и как её починить за минуту.",
                      views: 24000,
                      multiplier: 5.4,
                      format: "Короткое видео",
                      topic: "Практика и разборы",
                      publishedAt: new Date(Date.now() - 7200_000).toISOString(),
                    },
                  ],
                  reachSeries: Array.from({ length: 12 }, (_, i) =>
                    Math.round(2000 + i * 220 + Math.random() * 600),
                  ),
                }
              : c,
          ),
        }));
        toast({
          kind: "success",
          title: `Досье на «${name}» готово`,
          body: "Внутри — статистика, форматы и вывод ИИ.",
        });
        timers.current.delete(timer);
      }, 6000);
      timers.current.add(timer);
    },
    [patch, toast],
  );

  const removeCompetitor = useCallback<StoreValue["removeCompetitor"]>(
    (id) => patch((s) => ({ ...s, competitors: s.competitors.filter((c) => c.id !== id) })),
    [patch],
  );

  /* --------------------------------------------------------- ТРЕНДЫ */

  const trendToDraft = useCallback<StoreValue["trendToDraft"]>(
    (t) =>
      addPost({
        text:
          t.format === "video"
            ? `${t.hook ?? t.title}\n\n${t.script.join("\n")}`
            : `${t.title}\n\n${t.script[0] ?? ""}`,
        networks: ["tg", "vk"],
        status: "draft",
        origin: "trend",
        sourceRef: {
          kind: "trend",
          id: t.id,
          label: t.sourceName
            ? `Залёт у «${t.sourceName}» ×${t.multiplier.toString().replace(".", ",")}`
            : `Тренд сетей ×${t.multiplier.toString().replace(".", ",")}`,
        },
        media: { kind: t.format === "video" ? "video" : "image", label: "Из тренда", hue: t.hue },
      }),
    [addPost],
  );

  /* ------------------------------------------------------- АВТОПИЛОТ */

  const approveSlot = useCallback<StoreValue["approveSlot"]>(
    (id) =>
      patch((s) => ({
        ...s,
        autopilot: s.autopilot.map((x) => (x.id === id ? { ...x, status: "approved" } : x)),
      })),
    [patch],
  );

  const approveAllSlots = useCallback(
    () =>
      patch((s) => ({
        ...s,
        autopilot: s.autopilot.map((x) =>
          x.status === "rejected" ? x : { ...x, status: "approved" },
        ),
      })),
    [patch],
  );

  const rejectSlot = useCallback<StoreValue["rejectSlot"]>(
    (id) =>
      patch((s) => ({
        ...s,
        autopilot: s.autopilot.map((x) => (x.id === id ? { ...x, status: "rejected" } : x)),
      })),
    [patch],
  );

  const editSlot = useCallback<StoreValue["editSlot"]>(
    (id, p) =>
      patch((s) => ({
        ...s,
        autopilot: s.autopilot.map((x) => (x.id === id ? { ...x, ...p, status: "edited" } : x)),
      })),
    [patch],
  );

  // Одобренные слоты уходят в календарь настоящими постами
  const scheduleApproved = useCallback<StoreValue["scheduleApproved"]>(() => {
    let count = 0;
    setState((s) => {
      const monday = new Date();
      monday.setHours(0, 0, 0, 0);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + 7); // следующая неделя

      const created: Post[] = s.autopilot
        .filter((x) => x.status === "approved" || x.status === "edited")
        .map((x) => {
          const [h, m] = x.time.split(":").map(Number);
          const at = new Date(monday);
          at.setDate(at.getDate() + x.day);
          at.setHours(h, m, 0, 0);
          count += 1;
          return {
            id: uid("post"),
            legacyOwnerUserId: s.user?.id,
            text: x.text,
            networks: x.networks,
            scheduledAt: at.toISOString(),
            status: "scheduled" as const,
            origin: "autopilot" as const,
            sourceRef: x.sourceLabel
              ? { kind: "trend" as const, id: x.id, label: x.sourceLabel }
              : undefined,
            media: null,
            createdAt: new Date().toISOString(),
            attempts: 0,
          };
        });

      return {
        ...s,
        posts: [...created, ...s.posts],
        autopilot: s.autopilot.filter((x) => x.status === "pending" || x.status === "rejected"),
      };
    });
    return count;
  }, []);

  /* ------------------------------------------------------ НАСТРОЙКИ */

  const updateSettings = useCallback<StoreValue["updateSettings"]>(
    (p) => patch((s) => ({ ...s, settings: { ...s.settings, ...p } })),
    [patch],
  );

  const joinWaitlist = useCallback<StoreValue["joinWaitlist"]>(
    (contact) =>
      patch((s) => ({
        ...s,
        waitlist: [...s.waitlist, { contact, at: new Date().toISOString() }],
      })),
    [patch],
  );

  const reset = useCallback(() => {
    const identity = workspaceRef.current;
    try {
      if (identity) removeWorkspaceState(window.localStorage, identity);
    } catch {
      /* noop */
    }
    const user = activeUserRef.current;
    setState({
      ...seedState(),
      onboarded: user?.onboarded ?? false,
      user,
    });
  }, []);

  const value = useMemo<StoreValue>(
    () => ({
      ...state,
      ready,
      authReady,
      authError,
      toasts,
      toast,
      dismissToast,
      refreshAuth,
      signOut,
      finishOnboarding,
      realChannels,
      realPosts,
      realReady,
      realError,
      refreshReal,
      connectChannel,
      connectVkChannel,
      createRealPost,
      createPublicationOperation,
      retryRealPost,
      aiUsed,
      aiLimit,
      aiUsageStatus,
      refreshAiUsage,
      addPost,
      updatePost,
      removePost,
      retryPost,
      addCompetitor,
      removeCompetitor,
      trendToDraft,
      approveSlot,
      approveAllSlots,
      rejectSlot,
      editSlot,
      scheduleApproved,
      updateSettings,
      joinWaitlist,
      reset,
    }),
    [
      state,
      ready,
      authReady,
      authError,
      toasts,
      toast,
      dismissToast,
      refreshAuth,
      signOut,
      finishOnboarding,
      realChannels,
      realPosts,
      realReady,
      realError,
      refreshReal,
      connectChannel,
      connectVkChannel,
      createRealPost,
      createPublicationOperation,
      retryRealPost,
      aiUsed,
      aiLimit,
      aiUsageStatus,
      refreshAiUsage,
      addPost,
      updatePost,
      removePost,
      retryPost,
      addCompetitor,
      removeCompetitor,
      trendToDraft,
      approveSlot,
      approveAllSlots,
      rejectSlot,
      editSlot,
      scheduleApproved,
      updateSettings,
      joinWaitlist,
      reset,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
