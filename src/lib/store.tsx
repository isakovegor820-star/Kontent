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
import { uid } from "./utils";

const KEY = "aurora.state.v1";

type Toast = {
  id: string;
  kind: "success" | "danger" | "fire" | "info";
  title: string;
  body?: string;
};

interface StoreValue extends AppState {
  ready: boolean; // localStorage поднят (демо-данные)
  authReady: boolean; // /api/auth/me ответил — можно решать лендинг/платформа
  toasts: Toast[];
  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;

  /** Перечитать, кто вошёл, с сервера. Зовём после входа и при загрузке. */
  refreshAuth: () => Promise<void>;
  signOut: () => void;
  finishOnboarding: (patch?: { niche?: string; tone?: string }) => void;

  /* --- Настоящий постинг (Д.3): каналы и посты из базы --- */
  realChannels: RealChannel[];
  realPosts: RealPost[];
  realReady: boolean;
  refreshReal: () => Promise<void>;
  connectChannel: (handle: string) => Promise<{ ok: boolean; error?: string; title?: string }>;
  /** Подключить VK-сообщество по ключу доступа сообщества (право «Стена»). */
  connectVkChannel: (token: string) => Promise<{ ok: boolean; error?: string; title?: string }>;
  createRealPost: (input: {
    channelId: number;
    text: string;
    scheduledAt: string | null;
    media?: Post["media"];
  }) => Promise<{ ok: boolean; error?: string; postId?: number }>;
  retryRealPost: (id: number) => Promise<{ ok: boolean }>;

  /* --- ИИ-студия (Д.8): настоящий дневной лимит генераций --- */
  aiUsed: number;
  aiLimit: number;
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
  spendAi: (n?: number) => boolean;

  joinWaitlist: (contact: string) => void;
  reset: () => void;
}

const Ctx = createContext<StoreValue | null>(null);

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore должен вызываться внутри <StoreProvider>");
  return v;
}

function load(): AppState {
  if (typeof window === "undefined") return seedState();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return seedState();
    const parsed = JSON.parse(raw) as AppState;
    // Простая проверка формы — если схема поменялась, пересеиваем
    if (!parsed.posts || !parsed.competitors || !parsed.settings) return seedState();
    // user приходит с сервера (сессия), а не из localStorage — сбрасываем.
    return { ...parsed, user: null, onboarded: parsed.onboarded ?? false };
  } catch {
    return seedState();
  }
}

// Пользователь с сервера (/api/auth/me) → форма User для интерфейса.
type ServerUser = {
  id: number;
  tg_id: number | null;
  vk_id: number | null;
  email: string | null;
  name: string | null;
  avatar: string | null;
};

function mapUser(su: ServerUser, onboarded: boolean): User {
  const provider: User["provider"] = su.tg_id ? "telegram" : su.vk_id ? "vk" : "email";
  return {
    name: su.name || su.email?.split("@")[0] || "Ты",
    email: su.email || (su.tg_id ? `Telegram` : su.vk_id ? `VK` : ""),
    provider,
    onboarded,
  };
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState>(() => seedState());
  const [ready, setReady] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Кто вошёл — спрашиваем сервер (сессия в cookie). Зовём при загрузке и после входа.
  const refreshAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { user: ServerUser | null } | null;
      setState((s) => ({ ...s, user: data?.user ? mapUser(data.user, s.onboarded) : null }));
    } catch {
      setState((s) => ({ ...s, user: null }));
    } finally {
      setAuthReady(true);
    }
  }, []);

  useEffect(() => {
    // Загрузка сессии с сервера — side-effect; setState происходит внутри async-колбэка.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- запрос /api/auth/me при монтировании
    refreshAuth();
  }, [refreshAuth]);

  /* ------------------------------- НАСТОЯЩИЙ ПОСТИНГ (Д.3): каналы и посты */

  const [realChannels, setRealChannels] = useState<RealChannel[]>([]);
  const [realPosts, setRealPosts] = useState<RealPost[]>([]);
  const [realReady, setRealReady] = useState(false);

  const refreshReal = useCallback(async () => {
    try {
      const [chRes, poRes] = await Promise.all([
        fetch("/api/channels", { cache: "no-store" }),
        fetch("/api/posts", { cache: "no-store" }),
      ]);
      const ch = (await chRes.json().catch(() => null)) as { channels?: RealChannel[] } | null;
      const po = (await poRes.json().catch(() => null)) as { posts?: RealPost[] } | null;
      setRealChannels(ch?.channels ?? []);
      setRealPosts(po?.posts ?? []);
    } catch {
      /* сеть пропала — оставляем что было */
    } finally {
      setRealReady(true);
    }
  }, []);

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
    async ({ channelId, text, scheduledAt, media }) => {
      try {
        const res = await fetch("/api/posts/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId, text, scheduledAt, media }),
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

  const retryRealPost = useCallback<StoreValue["retryRealPost"]>(
    async (id) => {
      try {
        const res = await fetch(`/api/posts/${id}/retry`, { method: "POST" });
        await refreshReal();
        return { ok: res.ok };
      } catch {
        return { ok: false };
      }
    },
    [refreshReal],
  );

  /* ---------------------------- ИИ-студия (Д.8): реальный дневной лимит */

  const [aiUsed, setAiUsed] = useState(0);
  const [aiLimit, setAiLimit] = useState(30);

  const refreshAiUsage = useCallback(async () => {
    try {
      const r = await fetch("/api/ai/usage", { cache: "no-store" });
      const d = (await r.json().catch(() => null)) as { used?: number; limit?: number } | null;
      if (d) {
        setAiUsed(d.used ?? 0);
        setAiLimit(d.limit ?? 30);
      }
    } catch {
      /* сеть пропала — оставляем что было */
    }
  }, []);

  // Как только знаем пользователя — тянем его каналы и посты и держим их свежими
  // (пока открыта платформа): статусы двигаются на сервере, интерфейс это показывает.
  const hasUser = !!state.user;
  /* eslint-disable react-hooks/set-state-in-effect -- синхронизация реальных данных со входом */
  useEffect(() => {
    if (!hasUser) {
      setRealChannels([]);
      setRealPosts([]);
      setRealReady(false);
      setAiUsed(0);
      return;
    }
    refreshReal();
    refreshAiUsage();
    const t = setInterval(refreshReal, 8000);
    return () => clearInterval(t);
  }, [hasUser, refreshReal, refreshAiUsage]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Гидрация из localStorage — только на клиенте, после монтирования.
  // localStorage недоступен во время SSR, поэтому читаем его в эффекте (иначе
  // разошлась бы серверная и клиентская разметка). До гидрации ready=false —
  // экраны показывают скелетоны, а не чужие данные.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- гидрация из localStorage возможна только после монтирования
    setState(load());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* приватный режим — молча живём в памяти */
    }
  }, [state, ready]);

  useEffect(() => {
    const t = timers.current;
    return () => {
      t.forEach(clearTimeout);
      t.clear();
    };
  }, []);

  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = uid("t");
    setToasts((prev) => [...prev, { ...t, id }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
      timers.current.delete(timer);
    }, 5000);
    timers.current.add(timer);
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
    setState((s) => ({ ...s, user: null }));
    fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  }, []);

  const finishOnboarding = useCallback<StoreValue["finishOnboarding"]>(
    (p) =>
      patch((s) => ({
        ...s,
        onboarded: true,
        user: s.user ? { ...s.user, onboarded: true } : s.user,
        settings: { ...s.settings, ...(p ?? {}) },
      })),
    [patch],
  );

  /* ----------------------------------------------------------- ПОСТЫ */

  const addPost = useCallback<StoreValue["addPost"]>(
    (p) => {
      const post: Post = {
        id: uid("post"),
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
    [patch],
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

  // Честный дневной лимит ИИ (ТЗ, раздел 12: риск стоимости ИИ)
  const spendAi = useCallback<StoreValue["spendAi"]>(
    (n = 1) => {
      let ok = true;
      setState((s) => {
        if (s.settings.aiUsedToday + n > s.settings.aiDailyLimit) {
          ok = false;
          return s;
        }
        return { ...s, settings: { ...s.settings, aiUsedToday: s.settings.aiUsedToday + n } };
      });
      return ok;
    },
    [],
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
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* noop */
    }
    setState(seedState());
  }, []);

  const value = useMemo<StoreValue>(
    () => ({
      ...state,
      ready,
      authReady,
      toasts,
      toast,
      dismissToast,
      refreshAuth,
      signOut,
      finishOnboarding,
      realChannels,
      realPosts,
      realReady,
      refreshReal,
      connectChannel,
      connectVkChannel,
      createRealPost,
      retryRealPost,
      aiUsed,
      aiLimit,
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
      spendAi,
      joinWaitlist,
      reset,
    }),
    [
      state,
      ready,
      authReady,
      toasts,
      toast,
      dismissToast,
      refreshAuth,
      signOut,
      finishOnboarding,
      realChannels,
      realPosts,
      realReady,
      refreshReal,
      connectChannel,
      connectVkChannel,
      createRealPost,
      retryRealPost,
      aiUsed,
      aiLimit,
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
      spendAi,
      joinWaitlist,
      reset,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
