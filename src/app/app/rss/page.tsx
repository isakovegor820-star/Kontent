"use client";

// RSS-автопостинг: понятная настройка источника, управление каждой лентой и журнал.
// Экран намеренно объясняет весь путь записи до календаря: иначе фоновый воркер
// выглядит как чёрный ящик, а лимит «в день» легко принять за отложенную очередь.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Bot,
  CalendarClock,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  Gauge,
  Info,
  Link2,
  Newspaper,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rss,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input, Switch, Tabs } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import type { RankedRssSource } from "@/lib/rss-catalog";
import { cn, fmtAgo } from "@/lib/utils";
import { SourceCatalog, type RssCatalogContext } from "./source-catalog";

type Feed = {
  id: number;
  url: string;
  title: string | null;
  channel_id: number;
  channel_title: string | null;
  is_active: boolean;
  ai_summarize: boolean;
  publish_existing: boolean;
  max_per_day: number;
  last_fetched_at: string | null;
  created_at: string;
  items_24h: number;
  posted_24h: number;
  skipped_24h: number;
  limited_24h: number;
  irrelevant_24h: number;
  baseline_24h: number;
  paused_24h: number;
};

type Channel = { id: number; title: string; network: "tg" | "vk" };

type RssItem = {
  id: number;
  feed_id: number;
  title: string | null;
  link: string | null;
  published_at: string | null;
  status: "new" | "posted" | "skipped";
  skip_reason: "limit" | "irrelevant" | "baseline" | "paused" | null;
  post_status: "draft" | "scheduled" | "publishing" | "published" | "failed" | null;
  post_id: number | null;
  fetched_at: string;
  feed_title: string | null;
};

type JournalFilter = "all" | "posted" | "skipped";
type RssScreenView = "sources" | "journal";

const DAILY_LIMITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20];
const POLL_INTERVAL_MS = 4_000;
const POLL_ATTEMPTS = 10;

const WORKFLOW = [
  {
    icon: Rss,
    title: "Проверяем источник",
    body: "При подключении фиксируем текущие записи, затем забираем до 20 новых каждые 30 минут.",
  },
  {
    icon: FileText,
    title: "Берём только новое",
    body: "Одну и ту же новость не создаём повторно.",
  },
  {
    icon: Bot,
    title: "Адаптируем под канал",
    body: "ИИ учитывает тему и голос канала. Если адаптация не удалась, ничего не публикуем и повторяем позже.",
  },
  {
    icon: CalendarClock,
    title: "Ставим в календарь",
    body: "Первый пост — примерно через 5 минут, следующие разводим с интервалом 15 минут.",
  },
] as const;

function validFeedUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function StatusBadge({ item }: { item: RssItem }) {
  if (item.status === "posted") {
    if (item.post_status === "published") {
      return (
        <Badge tone="success">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          Опубликован
        </Badge>
      );
    }
    if (item.post_status === "failed") {
      return (
        <Badge tone="danger">
          <Info className="h-3.5 w-3.5" aria-hidden />
          Ошибка публикации
        </Badge>
      );
    }
    return (
      <Badge tone="brand">
        <CalendarClock className="h-3.5 w-3.5" aria-hidden />
        {item.post_status === "publishing" ? "Публикуется" : "Запланирован"}
      </Badge>
    );
  }
  if (item.status === "skipped") {
    if (item.skip_reason === "paused") {
      return (
        <Badge tone="neutral">
          <Pause className="h-3.5 w-3.5" aria-hidden />
          Отменено при паузе
        </Badge>
      );
    }
    if (item.skip_reason === "baseline") {
      return (
        <Badge tone="neutral">
          <Clock3 className="h-3.5 w-3.5" aria-hidden />
          Было до подключения
        </Badge>
      );
    }
    if (item.skip_reason === "irrelevant") {
      return (
        <Badge tone="neutral">
          <Gauge className="h-3.5 w-3.5" aria-hidden />
          Не подходит каналу
        </Badge>
      );
    }
    return (
      <Badge tone="neutral">
        <Gauge className="h-3.5 w-3.5" aria-hidden />
        {item.skip_reason === "limit" ? "Не создано: лимит" : "Не создано"}
      </Badge>
    );
  }
  return (
    <Badge tone="brand">
      <Clock3 className="h-3.5 w-3.5" aria-hidden />
      Обрабатываем
    </Badge>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  hint,
  tone = "plain",
}: {
  icon: typeof Rss;
  label: string;
  value: string | number;
  hint: string;
  tone?: "plain" | "success" | "fire";
}) {
  return (
    <Card className={cn("min-w-0 p-4", tone === "success" && "bg-success-soft", tone === "fire" && "bg-fire-soft")}>
      <div className="flex items-center gap-2 text-text-2">
        <Icon className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
        <span className="text-[12px] font-bold tracking-[0.08em] uppercase">{label}</span>
      </div>
      <p className="v3-display mt-3 text-[28px] font-black leading-none text-text">{value}</p>
      <p className="mt-2 text-[12px] leading-snug text-text-3">{hint}</p>
    </Card>
  );
}

function RssScreen() {
  const store = useStore();
  const router = useRouter();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [items, setItems] = useState<RssItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingFeedId, setPendingFeedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmEnableId, setConfirmEnableId] = useState<number | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestItemId = useRef<number | null>(null);
  const selectedChannelId = useRef<number | null>(null);

  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState("");
  const [channelId, setChannelId] = useState<number | null>(null);
  const [aiSummarize, setAiSummarize] = useState(true);
  const [includeExisting, setIncludeExisting] = useState(false);
  const [maxPerDay, setMaxPerDay] = useState(3);
  const [saving, setSaving] = useState(false);
  const [connectingSourceId, setConnectingSourceId] = useState<string | null>(null);
  const [creatingItemId, setCreatingItemId] = useState<number | null>(null);

  const [catalogSources, setCatalogSources] = useState<RankedRssSource[]>([]);
  const [catalogContext, setCatalogContext] = useState<RssCatalogContext | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState(false);

  const [journalFilter, setJournalFilter] = useState<JournalFilter>("all");
  const [journalFeedId, setJournalFeedId] = useState<number | "all">("all");
  const [screenView, setScreenView] = useState<RssScreenView>("sources");

  const createMaterial = async (item: RssItem) => {
    if (!channelId || creatingItemId != null) return;
    setCreatingItemId(item.id);
    try {
      const response = await fetch(`/api/rss/items/${item.id}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId }),
      });
      const result = (await response.json().catch(() => null)) as
        | { ok?: boolean; draft?: { id?: number }; error?: string }
        | null;
      const draftId = Number(result?.draft?.id);
      if (response.ok && result?.ok && Number.isSafeInteger(draftId) && draftId > 0) {
        router.push(`/app/studio?draft=${draftId}&intent=create`);
        return;
      }
      store.toast({
        kind: "danger",
        title: "Материал не создан",
        body: result?.error === "source_context_not_found"
          ? "Запись или её канал уже недоступны. Обнови журнал и попробуй другую."
          : "Источник не изменён. Попробуй ещё раз.",
      });
    } finally {
      setCreatingItemId(null);
    }
  };

  const loadFeeds = useCallback(async () => {
    const response = await fetch("/api/rss", { cache: "no-store" });
    if (!response.ok) throw new Error("feeds");
    const data = await response.json();
    const nextFeeds = ((data.feeds ?? []) as Feed[]).map((feed) => ({
      ...feed,
      id: Number(feed.id),
      channel_id: Number(feed.channel_id),
      items_24h: Number(feed.items_24h) || 0,
      posted_24h: Number(feed.posted_24h) || 0,
      skipped_24h: Number(feed.skipped_24h) || 0,
      limited_24h: Number(feed.limited_24h) || 0,
      irrelevant_24h: Number(feed.irrelevant_24h) || 0,
      baseline_24h: Number(feed.baseline_24h) || 0,
      paused_24h: Number(feed.paused_24h) || 0,
    }));
    setFeeds(nextFeeds);
    return nextFeeds;
  }, []);

  const loadItems = useCallback(async (wantedChannelId: number | null = selectedChannelId.current) => {
    const query = wantedChannelId ? `?channelId=${wantedChannelId}` : "";
    const response = await fetch(`/api/rss/items${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error("items");
    const data = await response.json();
    const nextItems = ((data.items ?? []) as RssItem[]).map((item) => ({
      ...item,
      id: Number(item.id),
      feed_id: Number(item.feed_id),
      post_id: item.post_id == null ? null : Number(item.post_id),
    }));
    // Проверка лент может продолжаться, пока человек уже переключил канал.
    // Результат старого канала возвращаем вызывающему, но не подменяем им экран нового.
    if (wantedChannelId === selectedChannelId.current) {
      latestItemId.current = nextItems[0]?.id ?? null;
      setItems(nextItems);
    }
    return nextItems;
  }, []);

  const loadCatalog = useCallback(async (wantedChannelId: number) => {
    setCatalogLoading(true);
    setCatalogError(false);
    try {
      const response = await fetch(`/api/rss/catalog?channelId=${wantedChannelId}`, { cache: "no-store" });
      if (!response.ok) throw new Error("catalog");
      const data = await response.json();
      setCatalogSources((data.sources ?? []) as RankedRssSource[]);
      setCatalogContext((data.context ?? null) as RssCatalogContext | null);
    } catch {
      setCatalogError(true);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const loadChannels = useCallback(async () => {
    const response = await fetch("/api/channels", { cache: "no-store" });
    if (!response.ok) throw new Error("channels");
    const data = await response.json();
    const nextChannels: Channel[] = (data.channels ?? [])
      .filter((channel: { network?: string }) => channel.network === "tg" || channel.network === "vk")
      .map((channel: { id: number; title: string; network: "tg" | "vk" }) => ({
        id: Number(channel.id),
        title: channel.title,
        network: channel.network,
      }))
      .filter((channel: Channel) => Number.isSafeInteger(channel.id) && channel.id > 0);
    setChannels(nextChannels);
    const channelFromUrl = typeof window === "undefined"
      ? null
      : Number(new URLSearchParams(window.location.search).get("channel")) || null;
    const preferredChannelId = selectedChannelId.current ?? channelFromUrl;
    const currentExists = nextChannels.some((channel) => channel.id === preferredChannelId);
    const nextChannelId = currentExists ? preferredChannelId : nextChannels[0]?.id ?? null;
    selectedChannelId.current = nextChannelId;
    setChannelId(nextChannelId);
    if (typeof window !== "undefined") {
      const nextUrl = new URL(window.location.href);
      if (nextChannelId) nextUrl.searchParams.set("channel", String(nextChannelId));
      else nextUrl.searchParams.delete("channel");
      window.history.replaceState(null, "", nextUrl);
    }
    return nextChannelId;
  }, []);

  const reload = useCallback(async () => {
    setLoadError(false);
    setLoading(true);
    try {
      const [, nextChannelId] = await Promise.all([loadFeeds(), loadChannels()]);
      if (nextChannelId) await Promise.all([loadItems(nextChannelId), loadCatalog(nextChannelId)]);
      else setItems([]);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [loadCatalog, loadChannels, loadFeeds, loadItems]);

  useEffect(() => {
    // Первичная синхронизация с API после гидрации клиентского экрана.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  const finishRefresh = useCallback(
    async (foundNew: boolean) => {
      await Promise.allSettled([loadFeeds(), loadItems()]);
      setRefreshing(false);
      store.toast({
        kind: foundNew ? "success" : "info",
        title: foundNew ? "Новые записи уже в журнале" : "Проверка завершена — новых записей нет",
      });
    },
    [loadFeeds, loadItems, store],
  );

  const pollRefresh = useCallback(
    async (baselineId: number | null, refreshedChannelId: number) => {
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await new Promise<void>((resolve) => {
          refreshTimer.current = setTimeout(resolve, POLL_INTERVAL_MS);
        });
        try {
          const nextItems = await loadItems(refreshedChannelId);
          const foundNew = (nextItems[0]?.id ?? null) !== baselineId;
          if (foundNew || attempt >= POLL_ATTEMPTS - 1) {
            await finishRefresh(foundNew);
            return;
          }
        } catch {
          if (attempt >= POLL_ATTEMPTS - 1) {
            setRefreshing(false);
            store.toast({ kind: "danger", title: "Не удалось получить результат проверки" });
            return;
          }
        }
      }
    },
    [finishRefresh, loadItems, store],
  );

  const refreshNow = useCallback(async () => {
    if (refreshing) return;
    if (!channelId) return;
    setRefreshing(true);
    const baselineId = latestItemId.current;
    const refreshedChannelId = channelId;
    try {
      const response = await fetch("/api/rss/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: refreshedChannelId }),
      });
      if (!response.ok) throw new Error("refresh");
      const targetChannel = channels.find((channel) => channel.id === refreshedChannelId);
      store.toast({ kind: "info", title: `Проверяю источники «${targetChannel?.title || "канала"}»` });
      void pollRefresh(baselineId, refreshedChannelId);
    } catch {
      setRefreshing(false);
      store.toast({ kind: "danger", title: "Не удалось запустить проверку" });
    }
  }, [channelId, channels, pollRefresh, refreshing, store]);

  const connectFeed = async (
    rawUrl: string,
    sourceId: string | null = null,
    preservedSettings?: { aiSummarize: boolean; maxPerDay: number },
  ) => {
    const trimmed = rawUrl.trim();
    if (!validFeedUrl(trimmed)) {
      setUrlError("Нужен полный адрес источника, начинающийся с http:// или https://");
      return;
    }
    if (!channelId) return;

    if (sourceId) setConnectingSourceId(sourceId);
    else setSaving(true);
    setUrlError("");
    try {
      const response = await fetch("/api/rss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: trimmed,
          channelId,
          aiSummarize: preservedSettings?.aiSummarize ?? aiSummarize,
          includeExisting,
          maxPerDay: preservedSettings?.maxPerDay ?? maxPerDay,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        if (data.error === "fetch_failed") {
          if (sourceId) store.toast({ kind: "danger", title: "Источник временно не отвечает" });
          else setUrlError("Источник не ответил или вернул слишком большой файл. Проверь адрес.");
        } else if (data.error === "bad_url") {
          if (sourceId) store.toast({ kind: "danger", title: "Адрес источника нужно обновить" });
          else setUrlError("Некорректный адрес источника.");
        } else if (data.error === "not_feed") {
          if (sourceId) store.toast({ kind: "danger", title: "По этому адресу нет новых материалов" });
          else setUrlError("Адрес открывается, но Аврора не нашла в нём поток материалов RSS/Atom.");
        } else if (data.error === "no_channel") {
          store.toast({ kind: "danger", title: "Выбранный канал недоступен" });
        } else {
          store.toast({ kind: "danger", title: "Не удалось сохранить источник" });
        }
        return;
      }

      setUrl("");
      await loadFeeds();
      store.toast({
        kind: "info",
        title: data.title ? `Источник «${data.title}» добавлен на паузе` : "Источник добавлен на паузе",
        body: `Ничего не будет опубликовано, пока ты отдельно не включишь автопубликацию.${
          data.itemCount ? ` В источнике найдено записей: ${data.itemCount}.` : ""
        }`,
      });
    } catch {
      store.toast({ kind: "danger", title: "Сетевая ошибка" });
    } finally {
      if (sourceId) setConnectingSourceId(null);
      else setSaving(false);
    }
  };

  const addFeed = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void connectFeed(url);
  };

  const connectCatalogSource = (source: RankedRssSource) => {
    const normalizedSourceUrl = source.url.trim().replace(/\/$/, "").toLocaleLowerCase("ru-RU");
    const existing = feeds.find(
      (feed) => feed.url.trim().replace(/\/$/, "").toLocaleLowerCase("ru-RU") === normalizedSourceUrl,
    );
    void connectFeed(
      source.url,
      source.id,
      existing ? { aiSummarize: existing.ai_summarize, maxPerDay: existing.max_per_day } : undefined,
    );
  };

  const changeChannel = (nextChannelId: number) => {
    if (!Number.isInteger(nextChannelId) || nextChannelId <= 0) return;
    selectedChannelId.current = nextChannelId;
    setChannelId(nextChannelId);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("channel", String(nextChannelId));
    window.history.replaceState(null, "", nextUrl);
    setJournalFeedId("all");
    setJournalFilter("all");
    setConfirmDeleteId(null);
    setConfirmEnableId(null);
    setItems([]);
    void Promise.all([loadItems(nextChannelId), loadCatalog(nextChannelId)]);
  };

  const patchFeed = async (
    feed: Feed,
    body: { isActive?: boolean; aiSummarize?: boolean; maxPerDay?: number },
    optimistic: Partial<Feed>,
  ) => {
    setPendingFeedId(feed.id);
    setFeeds((current) => current.map((item) => (item.id === feed.id ? { ...item, ...optimistic } : item)));
    try {
      const response = await fetch(`/api/rss/${feed.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error("patch");
      await Promise.allSettled([loadFeeds(), loadItems()]);
      if (body.isActive === false) {
        store.toast({
          kind: "info",
          title: "Автопубликация остановлена",
          body: data.cancelled
            ? `Отменено ожидающих постов из источника: ${data.cancelled}.`
            : "Ожидающих постов из источника не было.",
        });
      }
      return true;
    } catch {
      setFeeds((current) => current.map((item) => (item.id === feed.id ? feed : item)));
      store.toast({ kind: "danger", title: "Не удалось изменить настройки источника" });
      return false;
    } finally {
      setPendingFeedId(null);
    }
  };

  const enableFeed = async (feed: Feed) => {
    setConfirmEnableId(null);
    const enabled = await patchFeed(feed, { isActive: true }, { is_active: true, last_fetched_at: null });
    if (!enabled) return;
    store.toast({
      kind: "success",
      title: "Автопубликация включена",
      body: feed.publish_existing
        ? "На первом сборе могут быть взяты текущие записи — это было явно разрешено в настройке источника."
        : "Первый сбор только запомнит текущую историю. В канал пойдут записи, появившиеся после него.",
    });
    void refreshNow();
  };

  const removeFeed = async (feed: Feed) => {
    setPendingFeedId(feed.id);
    try {
      const response = await fetch(`/api/rss/${feed.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("delete");
      setFeeds((current) => current.filter((item) => item.id !== feed.id));
      setItems((current) => current.filter((item) => item.feed_id !== feed.id));
      setConfirmDeleteId(null);
      if (journalFeedId === feed.id) setJournalFeedId("all");
      store.toast({ kind: "info", title: "Источник и его журнал удалены" });
    } catch {
      store.toast({ kind: "danger", title: "Не удалось удалить источник" });
    } finally {
      setPendingFeedId(null);
    }
  };

  const selectedChannel = channels.find((channel) => channel.id === channelId) ?? null;
  const channelFeeds = useMemo(
    () => feeds.filter((feed) => feed.channel_id === channelId),
    [channelId, feeds],
  );
  const channelFeedIds = useMemo(
    () => new Set(channelFeeds.map((feed) => feed.id)),
    [channelFeeds],
  );
  const channelItems = useMemo(
    () => items.filter((item) => channelFeedIds.has(item.feed_id)),
    [channelFeedIds, items],
  );
  const activeFeeds = channelFeeds.filter((feed) => feed.is_active).length;
  const activeDailyCapacity = channelFeeds
    .filter((feed) => feed.is_active)
    .reduce((sum, feed) => sum + feed.max_per_day, 0);
  const posted24h = channelFeeds.reduce((sum, feed) => sum + feed.posted_24h, 0);
  const skipped24h = channelFeeds.reduce((sum, feed) => sum + feed.skipped_24h, 0);
  const limited24h = channelFeeds.reduce((sum, feed) => sum + feed.limited_24h, 0);
  const irrelevant24h = channelFeeds.reduce((sum, feed) => sum + feed.irrelevant_24h, 0);
  const baseline24h = channelFeeds.reduce((sum, feed) => sum + feed.baseline_24h, 0);
  const paused24h = channelFeeds.reduce((sum, feed) => sum + feed.paused_24h, 0);
  const lastFetchedAt = channelFeeds
    .map((feed) => feed.last_fetched_at)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

  const filteredItems = useMemo(
    () => channelItems.filter((item) => {
      const statusMatches = journalFilter === "all" || item.status === journalFilter;
      const feedMatches = journalFeedId === "all" || item.feed_id === journalFeedId;
      return statusMatches && feedMatches;
    }),
    [channelItems, journalFeedId, journalFilter],
  );

  const journalCounts = useMemo(() => ({
    all: channelItems.length,
    posted: channelItems.filter((item) => item.status === "posted").length,
    skipped: channelItems.filter((item) => item.status === "skipped").length,
  }), [channelItems]);

  return (
    <AppShell
      title="Источники контента"
      subtitle="Подключи сайты и медиа — Аврора отберёт новые материалы, адаптирует их под канал и поставит в календарь."
    >
      <div className="space-y-6">
        {loadError && (
          <Card className="flex flex-wrap items-center justify-between gap-3 bg-danger-soft p-4" role="alert">
            <div>
              <p className="text-[14px] font-bold text-danger-text">Не удалось загрузить часть данных</p>
              <p className="mt-0.5 text-[13px] text-text-2">Проверь соединение и попробуй ещё раз.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Повторить
            </Button>
          </Card>
        )}

        <Card className="overflow-hidden">
          <div className="flex flex-col gap-3 border-b-2 border-line bg-[var(--acc)] p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="v3-mono text-[11px] font-bold tracking-[0.16em] uppercase">Как это работает</p>
              <h2 className="v3-display mt-1.5 text-[20px] font-black sm:text-[24px]">От ссылки до готового поста</h2>
            </div>
            <span className="inline-flex w-fit items-center gap-2 border-2 border-line bg-surface px-3 py-2 text-[12px] font-bold shadow-[3px_3px_0_var(--ink)]">
              <Clock3 className="h-4 w-4" aria-hidden />
              Автопроверка каждые 30 минут
            </span>
          </div>

          <ol className="grid grid-cols-2 lg:grid-cols-4">
            {WORKFLOW.map((step, index) => {
              const Icon = step.icon;
              return (
                <li
                  key={step.title}
                  className={cn(
                    "relative border-line p-4 lg:p-5",
                    index < 2 && "border-b-2 lg:border-b-0",
                    index % 2 === 0 && "border-r-2",
                    index === 1 && "lg:border-r-2",
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className="v3-display flex h-9 w-9 shrink-0 items-center justify-center border-2 border-line bg-surface-inset text-[15px] font-black">
                      {index + 1}
                    </span>
                    <Icon className="h-5 w-5" strokeWidth={2} aria-hidden />
                  </div>
                  <p className="mt-3 text-[13px] font-bold text-text sm:mt-4 sm:text-[14px]">{step.title}</p>
                  <p className="mt-1.5 hidden text-[13px] leading-relaxed text-text-2 sm:block">{step.body}</p>
                  {index < WORKFLOW.length - 1 && (
                    <ArrowRight className="absolute top-7 -right-3 z-10 hidden h-5 w-5 bg-surface lg:block" aria-hidden />
                  )}
                </li>
              );
            })}
          </ol>

          <div className="flex items-start gap-2.5 border-t-2 border-line bg-fire-soft px-5 py-3.5">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-fire-text" aria-hidden />
            <p className="text-[13px] leading-relaxed text-text-2">
              <strong className="text-text">Лимит — это фильтр, не очередь.</strong>{" "}
              Записи сверх лимита не переносятся на следующий день. Текущие материалы нового источника по умолчанию только запоминаются, без автопубликации.
            </p>
          </div>
        </Card>

        {!loading && channels.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Link2 className="h-6 w-6" />}
              title="Сначала подключи канал"
              body="Источники контента создают посты для Telegram или VK. Подключи хотя бы один канал, затем вернись сюда и добавь первый сайт или медиа."
              action={
                <Link href="/app/settings">
                  <Button variant="brand" size="sm">
                    <Link2 className="h-4 w-4" aria-hidden />
                    Подключить канал
                  </Button>
                </Link>
              }
            />
          </Card>
        ) : (
          <>
            <Card as="section" className="overflow-hidden" aria-label="Канал для источников контента">
              <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-end lg:justify-between">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-line bg-[var(--acc)]">
                    <Send className="h-5 w-5" aria-hidden />
                  </span>
                  <div>
                    <p className="text-[12px] font-bold tracking-[0.08em] text-text-3 uppercase">Контекст раздела</p>
                    <h2 className="mt-1 text-[17px] font-black text-text">Источники для одного канала</h2>
                    <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-text-2">
                      Выбор меняет подборку, подключённые источники, сводку и журнал — данные каналов не смешиваются.
                    </p>
                  </div>
                </div>
                <label className="flex min-w-0 flex-col gap-1.5 text-[12px] font-bold text-text sm:min-w-72">
                  Выбранный канал
                  <select
                    id="rss-channel-context"
                    value={channelId ?? ""}
                    onChange={(event) => changeChannel(Number(event.target.value))}
                    className="h-11 w-full bg-surface px-3 text-[13px] font-bold text-text"
                  >
                    {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.title}</option>)}
                  </select>
                </label>
              </div>

              <div className="grid border-t-2 border-line bg-surface-inset sm:grid-cols-2 xl:grid-cols-4">
                <div className="flex items-center justify-between gap-4 border-b-2 border-line p-4 sm:border-r-2 xl:border-b-0">
                  <div>
                    <p className="text-[12px] font-black text-text">Новые источники</p>
                    <p className="mt-1 text-[11px] text-text-3">
                      {aiSummarize ? "ИИ проверит тему и адаптирует текст" : "Текст источника без проверки по теме"}
                    </p>
                  </div>
                  <Switch checked={aiSummarize} onChange={setAiSummarize} label="Адаптация под канал для новых источников" />
                </div>
                <div className="flex items-center justify-between gap-4 border-b-2 border-line p-4 xl:border-r-2 xl:border-b-0">
                  <div>
                    <p className="text-[12px] font-black text-text">Первый запуск</p>
                    <p className="mt-1 text-[11px] text-text-3">
                      {includeExisting ? "Можно взять текущие записи" : "Только то, что выйдет после подключения"}
                    </p>
                  </div>
                  <Switch checked={includeExisting} onChange={setIncludeExisting} label="Добавить текущие записи при первом запуске" />
                </div>
                <label className="flex items-center justify-between gap-3 border-b-2 border-line p-4 text-[12px] font-black text-text sm:border-r-2 sm:border-b-0 xl:border-r-2">
                  <span>
                    Лимит на источник
                    <span className="mt-1 block text-[11px] font-normal text-text-3">За скользящие 24 часа</span>
                  </span>
                  <select
                    id="rss-new-limit"
                    value={maxPerDay}
                    onChange={(event) => setMaxPerDay(Number(event.target.value))}
                    className="h-10 min-w-24 bg-surface px-2 text-[12px] font-bold text-text"
                  >
                    {DAILY_LIMITS.map((limit) => <option key={limit} value={limit}>{limit} / 24ч</option>)}
                  </select>
                </label>
                <div className="p-4">
                  <p className="text-[12px] font-black text-text">
                    {activeFeeds ? `До ${activeDailyCapacity} постов / 24 ч` : "Источники ещё не подключены"}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-text-3">
                    {activeFeeds
                      ? `Это сумма лимитов всех активных источников канала: ${activeFeeds}.`
                      : "После подключения здесь появится общий возможный объём."}
                  </p>
                </div>
              </div>
            </Card>

            <section aria-label="Сводка источников контента" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              {loading ? (
                [0, 1, 2, 3].map((index) => <div key={index} className="skeleton h-32" />)
              ) : (
                <>
                  <Metric icon={Rss} label="Активные источники" value={`${activeFeeds}/${channelFeeds.length}`} hint={`для «${selectedChannel?.title || "канала"}»`} />
                  <Metric icon={Send} label="Посты за 24 часа" value={posted24h} hint="созданы и поставлены в календарь" tone="success" />
                  <Metric
                    icon={Gauge}
                    label="Не создано"
                    value={skipped24h}
                    hint={`${limited24h} по лимиту · ${irrelevant24h} не по теме · ${baseline24h} были до подключения · ${paused24h} отменены паузой`}
                    tone={skipped24h ? "fire" : "plain"}
                  />
                  <Metric icon={Clock3} label="Последняя проверка" value={lastFetchedAt ? fmtAgo(lastFetchedAt) : "—"} hint="обновляем автоматически и вручную" />
                </>
              )}
            </section>

            <div className="flex items-center justify-between gap-3 border-b-2 border-line pb-3">
              <Tabs
                value={screenView}
                onChange={setScreenView}
                items={[
                  { value: "sources", label: `Источники ${channelFeeds.length}` },
                  { value: "journal", label: `Журнал ${channelItems.length}` },
                ]}
              />
              <p className="hidden text-[12px] text-text-3 sm:block">
                Канал: <span className="font-bold text-text-2">{selectedChannel?.title}</span>
              </p>
            </div>

            {screenView === "sources" && (
              <>
                <SourceCatalog
                  sources={catalogSources}
                  context={catalogContext}
                  channelId={channelId}
                  feeds={feeds}
                  loading={catalogLoading}
                  error={catalogError}
                  connectingId={connectingSourceId}
                  onConnect={connectCatalogSource}
                  onRetry={() => channelId && void loadCatalog(channelId)}
                />

                <div className="grid items-start gap-6 xl:grid-cols-[minmax(320px,0.78fr)_minmax(0,1.22fr)]">
              <Card as="section" className="overflow-hidden" aria-labelledby="add-feed-title">
                <div className="border-b-2 border-line p-5">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center border-2 border-line bg-[var(--acc)]">
                      <Plus className="h-5 w-5" strokeWidth={2.5} aria-hidden />
                    </span>
                    <div>
                      <h2 id="add-feed-title" className="text-[16px] font-black text-text">Свой источник по ссылке</h2>
                      <p className="mt-0.5 text-[13px] text-text-3">Если нужного сайта нет в готовом каталоге.</p>
                    </div>
                  </div>
                </div>

                <form onSubmit={addFeed} className="space-y-5 p-5" noValidate>
                  <div>
                    <label htmlFor="rss-url" className="block text-[13px] font-bold text-text">
                      Адрес источника
                    </label>
                    <Input
                      id="rss-url"
                      type="url"
                      inputMode="url"
                      autoComplete="url"
                      value={url}
                      onChange={(event) => {
                        setUrl(event.target.value);
                        if (urlError) setUrlError("");
                      }}
                      placeholder="https://site.ru/feed.xml"
                      aria-invalid={Boolean(urlError)}
                      aria-describedby={urlError ? "rss-url-error" : "rss-url-hint"}
                      className="mt-2"
                    />
                    {urlError ? (
                      <p id="rss-url-error" role="alert" className="mt-2 text-[12px] font-semibold text-danger-text">{urlError}</p>
                    ) : (
                      <p id="rss-url-hint" className="mt-2 text-[12px] leading-relaxed text-text-3">
                        Нужна техническая ссылка источника — часто она заканчивается на /feed, /rss.xml или /atom.xml.
                      </p>
                    )}
                  </div>

                  <div className="border-2 border-line bg-surface-inset p-3.5">
                    <p className="text-[12px] font-bold text-text">Куда и как подключим</p>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-text-2">
                      «{selectedChannel?.title || "Выбранный канал"}» · {aiSummarize ? "адаптация под канал" : "текст источника без адаптации"} · до {maxPerDay} постов / 24 ч · {includeExisting ? "можно взять текущие записи" : "только новые после подключения"}.
                    </p>
                    <p className="mt-1 text-[11px] text-text-3">Сначала источник будет добавлен на паузе. Автопубликацию включишь отдельно в его карточке.</p>
                  </div>

                  <Button type="submit" variant="brand" size="md" loading={saving} disabled={!url.trim() || !channelId} className="w-full">
                    <Plus className="h-4 w-4" aria-hidden />
                    Добавить на паузе
                  </Button>
                </form>
              </Card>

              <Card as="section" className="overflow-hidden" aria-labelledby="feeds-title">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-line p-5">
                  <div>
                    <h2 id="feeds-title" className="text-[16px] font-black text-text">Подключённые источники</h2>
                    <p className="mt-0.5 text-[13px] text-text-3">Настройки применяются со следующей проверки.</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void refreshNow()}
                    loading={refreshing}
                    disabled={!activeFeeds}
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    {refreshing ? "Проверяем" : "Проверить источники канала"}
                  </Button>
                </div>

                {loading ? (
                  <div className="space-y-3 p-5">
                    {[0, 1].map((index) => <div key={index} className="skeleton h-44" />)}
                  </div>
                ) : channelFeeds.length === 0 ? (
                  <EmptyState
                    icon={<Rss className="h-5 w-5" />}
                    title="Источников пока нет"
                    body="Добавь первый источник слева. Мы проверим адрес, но ничего не опубликуем до отдельного включения."
                  />
                ) : (
                  <div className="divide-y-2 divide-line">
                    {channelFeeds.map((feed) => {
                      const busy = pendingFeedId === feed.id;
                      const deleting = confirmDeleteId === feed.id;
                      const enabling = confirmEnableId === feed.id;
                      return (
                        <article key={feed.id} className={cn("p-5 transition-colors", !feed.is_active && "bg-surface-inset")}>
                          <div className="flex items-start gap-3">
                            <span className={cn(
                              "flex h-10 w-10 shrink-0 items-center justify-center border-2 border-line",
                              feed.is_active ? "bg-[var(--acc)]" : "bg-surface",
                            )}>
                              {feed.is_active ? <Rss className="h-5 w-5" aria-hidden /> : <Pause className="h-5 w-5" aria-hidden />}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="min-w-0 truncate text-[14px] font-black text-text">{feed.title || feed.url}</h3>
                                <Badge tone={feed.is_active ? "success" : "neutral"}>
                                  {feed.is_active ? (feed.last_fetched_at ? "Включена" : "Ждёт первой проверки") : "На паузе"}
                                </Badge>
                              </div>
                              <a
                                href={feed.url}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1.5 flex max-w-full items-center gap-1.5 text-[12px] text-text-3 underline-offset-4 hover:text-text hover:underline"
                              >
                                <span className="truncate">{feed.url}</span>
                                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                              </a>
                            </div>
                          </div>

                          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] text-text-2">
                            <span className="inline-flex items-center gap-1.5 font-bold">
                              <Send className="h-3.5 w-3.5" aria-hidden />
                              {feed.channel_title || "Канал недоступен"}
                            </span>
                            <span aria-hidden>·</span>
                            <span>{feed.posted_24h} создано</span>
                            {feed.skipped_24h > 0 && (
                              <>
                                <span aria-hidden>·</span>
                                <span className="font-semibold text-fire-text">{feed.skipped_24h} не создано</span>
                              </>
                            )}
                            <span aria-hidden>·</span>
                            <span>{feed.last_fetched_at ? `проверена ${fmtAgo(feed.last_fetched_at)}` : "ещё не проверялась"}</span>
                          </div>

                          <div className="mt-4 grid gap-3 border-t-2 border-line pt-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                            <div className="flex min-w-0 items-center justify-between gap-3 sm:justify-start">
                              <span className="text-[12px] font-bold text-text">Адаптация</span>
                              <Switch
                                checked={feed.ai_summarize}
                                onChange={(checked) => void patchFeed(feed, { aiSummarize: checked }, { ai_summarize: checked })}
                                label={`Адаптация под канал для ${feed.title || feed.url}`}
                              />
                            </div>
                            <label className="flex items-center justify-between gap-2 text-[12px] font-bold text-text">
                              Лимит
                              <select
                                value={feed.max_per_day}
                                disabled={busy}
                                onChange={(event) => {
                                  const value = Number(event.target.value);
                                  void patchFeed(feed, { maxPerDay: value }, { max_per_day: value });
                                }}
                                aria-label={`Лимит постов для ${feed.title || feed.url}`}
                                className="h-11 min-w-24 bg-surface px-2 text-[12px] font-bold"
                              >
                                {DAILY_LIMITS.map((limit) => <option key={limit} value={limit}>{limit} / 24ч</option>)}
                              </select>
                            </label>
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                disabled={busy}
                                onClick={() => {
                                  if (feed.is_active) {
                                    void patchFeed(feed, { isActive: false }, { is_active: false });
                                  } else {
                                    setConfirmDeleteId(null);
                                    setConfirmEnableId(enabling ? null : feed.id);
                                  }
                                }}
                                title={feed.is_active ? "Остановить автопубликацию" : "Включить автопубликацию"}
                                aria-label={feed.is_active ? `Остановить автопубликацию ${feed.title || "источника"}` : `Включить автопубликацию ${feed.title || "источника"}`}
                              >
                                {feed.is_active ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                disabled={busy}
                                onClick={() => {
                                  setConfirmEnableId(null);
                                  setConfirmDeleteId(deleting ? null : feed.id);
                                }}
                                className="text-danger-text"
                                title="Удалить источник"
                                aria-label={`Удалить ${feed.title || "источник"}`}
                              >
                                <Trash2 className="h-4 w-4" aria-hidden />
                              </Button>
                            </div>
                          </div>

                          {enabling && (
                            <div className="mt-4 flex flex-col gap-3 border-2 border-line bg-fire-soft p-3.5 sm:flex-row sm:items-center sm:justify-between" role="alert">
                              <p className="text-[12px] leading-relaxed text-text-2">
                                <strong className="text-text">Включить автопубликацию?</strong>{" "}
                                После первого безопасного сбора новые подходящие записи будут сами ставиться в календарь и выходить без подтверждения каждой записи — до {feed.max_per_day} за 24 часа.
                              </p>
                              <div className="flex shrink-0 gap-2">
                                <Button variant="ghost" size="sm" onClick={() => setConfirmEnableId(null)}>Отмена</Button>
                                <Button variant="solid" size="sm" loading={busy} onClick={() => void enableFeed(feed)}>Включить</Button>
                              </div>
                            </div>
                          )}

                          {deleting && (
                            <div className="mt-4 flex flex-col gap-3 border-2 border-line bg-danger-soft p-3.5 sm:flex-row sm:items-center sm:justify-between" role="alert">
                              <p className="text-[12px] leading-relaxed text-text-2">
                                Удалить источник и его журнал? Уже созданные посты останутся в календаре.
                              </p>
                              <div className="flex shrink-0 gap-2">
                                <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Отмена</Button>
                                <Button variant="danger" size="sm" loading={busy} onClick={() => void removeFeed(feed)}>Удалить</Button>
                              </div>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </Card>
                </div>
              </>
            )}

            {screenView === "journal" && (
              <Card as="section" className="overflow-hidden" aria-labelledby="journal-title">
              <div className="flex flex-col gap-4 border-b-2 border-line p-5 lg:flex-row lg:items-end lg:justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center border-2 border-line bg-surface-inset">
                    <Newspaper className="h-5 w-5" aria-hidden />
                  </span>
                  <div>
                    <h2 id="journal-title" className="text-[16px] font-black text-text">Журнал обработки</h2>
                    <p className="mt-0.5 text-[13px] text-text-3">Последние 30 записей и их результат.</p>
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {channelFeeds.length > 1 && (
                    <select
                      value={journalFeedId}
                      onChange={(event) => setJournalFeedId(event.target.value === "all" ? "all" : Number(event.target.value))}
                      aria-label="Фильтр журнала по источнику"
                      className="h-10 min-w-44 bg-surface px-2 text-[12px] font-bold text-text"
                    >
                      <option value="all">Все источники</option>
                      {channelFeeds.map((feed) => <option key={feed.id} value={feed.id}>{feed.title || feed.url}</option>)}
                    </select>
                  )}
                  <Tabs
                    value={journalFilter}
                    onChange={setJournalFilter}
                    className="max-w-full overflow-x-auto"
                    items={[
                      { value: "all", label: `Все ${journalCounts.all}` },
                      { value: "posted", label: `Созданы ${journalCounts.posted}` },
                      { value: "skipped", label: `Не созданы ${journalCounts.skipped}` },
                    ]}
                  />
                </div>
              </div>

              {loading ? (
                <div className="space-y-3 p-5">
                  {[0, 1, 2].map((index) => <div key={index} className="skeleton h-20" />)}
                </div>
              ) : channelItems.length === 0 ? (
                <EmptyState
                  icon={<Newspaper className="h-5 w-5" />}
                  title="Пока ничего не приходило"
                  body="Подключи источник или нажми «Проверить источники канала». Новые записи появятся здесь вместе со статусом."
                />
              ) : filteredItems.length === 0 ? (
                <EmptyState
                  icon={<Newspaper className="h-5 w-5" />}
                  title="По этому фильтру записей нет"
                  body="Выбери другой статус или источник."
                  action={<Button variant="outline" size="sm" onClick={() => { setJournalFilter("all"); setJournalFeedId("all"); }}>Сбросить фильтр</Button>}
                />
              ) : (
                <div className="divide-y-2 divide-line">
                  {filteredItems.map((item) => (
                    <article key={item.id} className="grid gap-3 p-4 transition-colors hover:bg-surface-inset sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="truncate text-[14px] font-bold text-text">{item.title || item.link || "Без заголовка"}</p>
                          {item.link && (
                            <a
                              href={item.link}
                              target="_blank"
                              rel="noreferrer"
                              aria-label="Открыть оригинал"
                              className="inline-flex h-10 w-10 shrink-0 items-center justify-center text-text-3 transition-colors hover:bg-surface-inset hover:text-text"
                            >
                              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                            </a>
                          )}
                        </div>
                        <p className="mt-1.5 text-[12px] text-text-3">
                          <span className="font-semibold text-text-2">{item.feed_title || "Источник"}</span>
                          <span aria-hidden> · </span>
                          {fmtAgo(item.published_at ?? item.fetched_at)}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                        <StatusBadge item={item} />
                        <Button
                          size="sm"
                          variant="soft"
                          loading={creatingItemId === item.id}
                          disabled={creatingItemId != null}
                          onClick={() => void createMaterial(item)}
                        >
                          <Sparkles className="h-3.5 w-3.5" aria-hidden />
                          Создать материал
                        </Button>
                        {item.status === "posted" && item.post_id && (
                          <Link href={`/app/calendar#calendar-real-${item.post_id}`} className="inline-flex h-10 items-center gap-1.5 px-2 text-[12px] font-bold text-text underline-offset-4 hover:underline">
                            В календарь
                            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                          </Link>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}

              <div className="flex items-start gap-2.5 border-t-2 border-line bg-surface-inset px-5 py-3.5">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <p className="text-[12px] leading-relaxed text-text-2">
                  Здесь показан реальный статус поста: запланирован, опубликован или остановлен из-за ошибки. Первый новый пост ставится примерно через 5 минут, следующие — с интервалом 15 минут.
                </p>
              </div>
              </Card>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

export default function RssPage() {
  return <RssScreen />;
}
