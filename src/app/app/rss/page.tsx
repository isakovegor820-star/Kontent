"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  Bookmark,
  BookmarkCheck,
  BriefcaseBusiness,
  CalendarCheck2,
  CheckCheck,
  CheckCircle2,
  Clock3,
  Eye,
  EyeOff,
  ExternalLink,
  Gavel,
  Lightbulb,
  RefreshCw,
  Scale,
  Sparkles,
  Target,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import {
  OpportunityPostDialog,
  type OpportunityPostDialogTarget,
} from "@/components/app/opportunity-post-dialog";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import {
  isLegalOpportunityPostNetwork,
  type LegalOpportunityPostVariant,
} from "@/lib/legal-opportunity-post";
import {
  classifyLegalOpportunity,
  isLikelyLegalOpportunity,
  legalOpportunityFingerprint,
  type LegalOpportunityInsight,
  type LegalOpportunityPriority,
} from "@/lib/legal-opportunities";
import {
  emitLegalOpportunityUnreadCount,
  legalOpportunityVisualState,
  safeLegalOpportunityUnreadCount,
  type LegalOpportunityVisualState,
} from "@/lib/legal-opportunity-unread";
import { useStore } from "@/lib/store";
import type { Network, RealChannel } from "@/lib/types";
import { cn, fmtAgo, plural } from "@/lib/utils";

type OpportunityState = "saved" | "dismissed" | "used" | null;
type OpportunityView = "for-you" | "saved" | "used" | "hidden";

type Channel = {
  id: number;
  title: string | null;
  handle: string | null;
  network: Network;
  is_active: boolean;
};

type Feed = {
  id: number;
  channel_id: number;
  is_active: boolean;
  last_fetched_at: string | null;
};

type LegalItem = {
  id: number;
  feed_id: number;
  channel_id: number;
  channel_title: string | null;
  title: string | null;
  summary: string | null;
  link: string | null;
  published_at: string | null;
  fetched_at: string;
  status: "new" | "posted" | "skipped";
  skip_reason: "limit" | "irrelevant" | "baseline" | "paused" | null;
  post_status: "draft" | "scheduled" | "publishing" | "published" | "failed" | null;
  post_id: number | null;
  feed_title: string | null;
  feed_url: string;
  opportunity_state: OpportunityState;
  read_at: string | null;
};

type EnrichedItem = LegalItem & { insight: LegalOpportunityInsight };

const PRIORITY_ORDER: Record<LegalOpportunityPriority, number> = {
  high: 0,
  medium: 1,
  standard: 2,
};

const VIEW_COPY: Record<OpportunityView, { title: string; body: string }> = {
  "for-you": {
    title: "Для вас сегодня",
    body: "Аврора отобрала события, которые можно превратить в полезный юридический контент.",
  },
  saved: {
    title: "Сохранённые инфоповоды",
    body: "Материалы, к которым вы решили вернуться позже.",
  },
  used: {
    title: "Использованные инфоповоды",
    body: "События, по которым уже создавался материал или публикация.",
  },
  hidden: {
    title: "Скрытые инфоповоды",
    body: "Материалы, которые вы убрали из основной подборки. Их можно вернуть в любой момент.",
  },
};

function parseView(value: string | null): OpportunityView {
  if (value === "saved" || value === "used" || value === "hidden") return value;
  return "for-you";
}

function priorityTone(priority: LegalOpportunityPriority): "danger" | "fire" | "neutral" {
  if (priority === "high") return "danger";
  if (priority === "medium") return "fire";
  return "neutral";
}

function timeValue(item: LegalItem) {
  return Date.parse(item.published_at || item.fetched_at) || 0;
}

const VISUAL_STATE_COPY: Record<LegalOpportunityVisualState, {
  label: string;
  tone: "brand" | "neutral" | "success";
}> = {
  new: { label: "Новый", tone: "brand" },
  viewed: { label: "Просмотрен", tone: "neutral" },
  used: { label: "Использован", tone: "success" },
  hidden: { label: "Скрыт", tone: "neutral" },
};

function OpportunityCard({
  item,
  busy,
  stateBusy,
  onCreate,
  onState,
  onViewed,
}: {
  item: EnrichedItem;
  busy: boolean;
  stateBusy: boolean;
  onCreate: (item: EnrichedItem) => void;
  onState: (item: LegalItem, state: OpportunityState) => void;
  onViewed: (itemId: number) => void;
}) {
  const ready = item.post_id != null || item.opportunity_state === "used";
  const saved = item.opportunity_state === "saved";
  const visualState = legalOpportunityVisualState(item);
  const hidden = visualState === "hidden";
  const visualCopy = VISUAL_STATE_COPY[visualState];

  return (
    <Card
      as="article"
      data-opportunity-id={item.id}
      data-opportunity-state={visualState}
      className={cn(
        "overflow-hidden transition-[background-color,box-shadow,opacity] duration-150 motion-reduce:transition-none",
        visualState === "new" && "bg-info-soft/25 ring-2 ring-brand/20",
        hidden && "bg-surface-inset/65",
      )}
    >
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={visualCopy.tone} className="nums">
            {visualState === "new" ? <Sparkles className="h-3.5 w-3.5" aria-hidden /> : null}
            {visualState === "viewed" ? <Eye className="h-3.5 w-3.5" aria-hidden /> : null}
            {visualState === "used" ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : null}
            {visualState === "hidden" ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : null}
            {visualCopy.label}
          </Badge>
          <Badge tone={priorityTone(item.insight.priority)}>
            {item.insight.priority === "high" ? <Clock3 className="h-3.5 w-3.5" aria-hidden /> : <Lightbulb className="h-3.5 w-3.5" aria-hidden />}
            {item.insight.priorityLabel}
          </Badge>
          <Badge tone="brand"><Scale className="h-3.5 w-3.5" aria-hidden />{item.insight.status}</Badge>
          <Badge tone="neutral">{item.insight.practice}</Badge>
          {ready && <Badge tone="success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Материал готов</Badge>}
        </div>

        <h3 className="mt-4 max-w-3xl text-balance text-[20px] font-black leading-[1.2] text-text sm:text-[23px]">
          {item.insight.title}
        </h3>
        <p className="mt-3 max-w-3xl text-pretty text-[14px] leading-relaxed text-text-2 sm:text-[15px]">
          {item.insight.summary}
        </p>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <div className="rounded-sm bg-info-soft p-4">
            <div className="flex items-center gap-2 text-info-text">
              <Target className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
              <p className="text-[12px] font-bold tracking-[0.08em] uppercase">Почему это важно</p>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-text-2">{item.insight.whyImportant}</p>
          </div>
          <div className="rounded-sm bg-surface-inset p-4">
            <div className="flex items-center gap-2 text-text-2">
              <BriefcaseBusiness className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
              <p className="text-[12px] font-bold tracking-[0.08em] uppercase">Кого касается</p>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-text-2">{item.insight.audience}</p>
          </div>
        </div>

        <details
          className="group mt-4 rounded-sm bg-surface-2 px-4 py-3"
          onToggle={(event) => {
            if (event.currentTarget.open) onViewed(item.id);
          }}
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-[13px] font-bold text-text marker:hidden">
            Подробнее о событии
            <ArrowRight className="h-4 w-4 shrink-0 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
          </summary>
          <div className="border-t border-line pt-3 pb-1">
            <p className="text-[12px] font-bold tracking-[0.08em] text-text-3 uppercase">Идея подачи</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-text-2">{item.insight.contentAngle}</p>
            <p className="mt-3 text-[12px] leading-relaxed text-text-3">
              Перед публикацией Аврора повторно передаст модели заголовок, описание и ссылку на этот материал. Юридический статус показан по формулировкам источника.
            </p>
          </div>
        </details>

        <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-[12px] leading-relaxed text-text-3">
            <a
              href={item.link || item.feed_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 max-w-full items-center gap-1.5 font-semibold text-text-2 underline-offset-4 hover:text-brand hover:underline focus-visible:rounded-xs focus-visible:ring-4 focus-visible:ring-brand/15"
              aria-label={`Открыть источник: ${item.insight.sourceLabel}`}
            >
              <span className="truncate">{item.insight.sourceLabel}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
            </a>
            <span aria-hidden className="mx-2">·</span>
            <span className="nums whitespace-nowrap">{fmtAgo(item.published_at || item.fetched_at)}</span>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={saved ? "soft" : "ghost"}
              size="sm"
              loading={stateBusy && saved}
              disabled={stateBusy || busy}
              onClick={() => onState(item, saved ? null : "saved")}
              aria-pressed={saved}
            >
              {saved ? <BookmarkCheck className="h-4 w-4" aria-hidden /> : <Bookmark className="h-4 w-4" aria-hidden />}
              {saved ? "Сохранено" : "Сохранить"}
            </Button>
            <Button
              type="button"
              variant={hidden ? "secondary" : "ghost"}
              size="sm"
              disabled={stateBusy || busy}
              onClick={() => onState(item, hidden ? null : "dismissed")}
            >
              {hidden ? <Eye className="h-4 w-4" aria-hidden /> : <EyeOff className="h-4 w-4" aria-hidden />}
              {hidden ? "Вернуть в подборку" : "Скрыть"}
            </Button>
            <Button
              type="button"
              variant="brand"
              size="sm"
              loading={busy}
              disabled={stateBusy}
              onClick={() => onCreate(item)}
            >
              {item.post_id ? <CalendarCheck2 className="h-4 w-4" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
              {item.post_id ? "Открыть в календаре" : "Создать пост"}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function LegalOpportunitiesScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const store = useStore();
  const view = parseView(searchParams.get("view"));
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelId, setChannelId] = useState<number | null>(null);
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [items, setItems] = useState<LegalItem[]>([]);
  const [practice, setPractice] = useState("Все практики");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [automationError, setAutomationError] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [creatingItemId, setCreatingItemId] = useState<number | null>(null);
  const [postDialogItem, setPostDialogItem] = useState<EnrichedItem | null>(null);
  const [stateItemId, setStateItemId] = useState<number | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [markingAll, setMarkingAll] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const itemsRef = useRef<LegalItem[]>([]);
  const unreadCountRef = useRef(0);
  const viewedInFlightRef = useRef(new Set<number>());
  const opportunityListRef = useRef<HTMLDivElement>(null);

  const updateItems = useCallback((update: LegalItem[] | ((current: LegalItem[]) => LegalItem[])) => {
    const next = typeof update === "function" ? update(itemsRef.current) : update;
    itemsRef.current = next;
    setItems(next);
  }, []);

  const publishUnreadCount = useCallback((value: unknown) => {
    const next = safeLegalOpportunityUnreadCount(value);
    unreadCountRef.current = next;
    setUnreadCount(next);
    emitLegalOpportunityUnreadCount(next);
  }, []);

  const loadData = useCallback(async (wantedChannelId: number, withLoader = false) => {
    if (withLoader) setLoading(true);
    setLoadError(false);
    try {
      const [feedsResponse, itemsResponse, unreadResponse] = await Promise.all([
        fetch("/api/rss?sourceKind=legal_opportunity", { cache: "no-store" }),
        fetch(`/api/rss/items?channelId=${wantedChannelId}`, { cache: "no-store" }),
        fetch("/api/rss/items?summary=unread", { cache: "no-store" }),
      ]);
      if (!feedsResponse.ok || !itemsResponse.ok || !unreadResponse.ok) throw new Error("load_failed");
      const [feedsBody, itemsBody, unreadBody] = await Promise.all([
        feedsResponse.json(),
        itemsResponse.json(),
        unreadResponse.json(),
      ]);
      setFeeds(((feedsBody.feeds ?? []) as Feed[]).map((feed) => ({
        ...feed,
        id: Number(feed.id),
        channel_id: Number(feed.channel_id),
      })));
      updateItems(((itemsBody.items ?? []) as LegalItem[]).map((item) => ({
        ...item,
        id: Number(item.id),
        feed_id: Number(item.feed_id),
        channel_id: Number(item.channel_id),
        post_id: item.post_id == null ? null : Number(item.post_id),
        opportunity_state: item.opportunity_state ?? null,
        read_at: item.read_at ?? null,
      })));
      publishUnreadCount(unreadBody.unreadCount);
      setLastUpdatedAt(new Date());
    } catch {
      setLoadError(true);
    } finally {
      if (withLoader) setLoading(false);
    }
  }, [publishUnreadCount, updateItems]);

  const startAutomaticMonitoring = useCallback(async (wantedChannelId: number) => {
    setPreparing(true);
    setAutomationError(false);
    try {
      const response = await fetch("/api/rss/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: wantedChannelId }),
      });
      if (!response.ok) throw new Error("bootstrap_failed");
      await loadData(wantedChannelId, true);
      pollTimer.current = setTimeout(() => {
        void loadData(wantedChannelId).finally(() => setPreparing(false));
      }, 5_000);
    } catch {
      setAutomationError(true);
      setPreparing(false);
      await loadData(wantedChannelId, true);
    }
  }, [loadData]);

  const initialize = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch("/api/channels", { cache: "no-store" });
      if (!response.ok) throw new Error("channels_failed");
      const body = await response.json();
      const nextChannels = ((body.channels ?? []) as Channel[])
        .filter((channel) => isLegalOpportunityPostNetwork(channel.network) && channel.is_active)
        .map((channel) => ({ ...channel, id: Number(channel.id) }));
      setChannels(nextChannels);
      const nextMonitorChannels = nextChannels.filter((channel) => (
        channel.network === "tg" || channel.network === "vk"
      ));
      const requested = typeof window === "undefined"
        ? null
        : Number(new URLSearchParams(window.location.search).get("channel"));
      const wanted = nextMonitorChannels.some((channel) => channel.id === requested)
        ? requested
        : nextMonitorChannels[0]?.id ?? null;
      setChannelId(wanted);
      if (!wanted) {
        publishUnreadCount(0);
        setLoading(false);
        return;
      }
      await startAutomaticMonitoring(wanted);
      refreshInterval.current = setInterval(() => void loadData(wanted), 30_000);
    } catch {
      setLoadError(true);
      setLoading(false);
    }
  }, [loadData, publishUnreadCount, startAutomaticMonitoring]);

  useEffect(() => {
    const startupTimer = setTimeout(() => void initialize(), 0);
    const handleProjectChange = () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (refreshInterval.current) clearInterval(refreshInterval.current);
      publishUnreadCount(0);
      void initialize();
    };
    window.addEventListener("aurora:project-changed", handleProjectChange);
    return () => {
      clearTimeout(startupTimer);
      if (pollTimer.current) clearTimeout(pollTimer.current);
      if (refreshInterval.current) clearInterval(refreshInterval.current);
      window.removeEventListener("aurora:project-changed", handleProjectChange);
    };
  }, [initialize, publishUnreadCount]);

  const markViewed = useCallback(async (itemId: number) => {
    if (viewedInFlightRef.current.has(itemId)) return;
    const item = itemsRef.current.find((entry) => entry.id === itemId);
    if (!item || legalOpportunityVisualState(item) !== "new") return;

    viewedInFlightRef.current.add(itemId);
    const optimisticAt = new Date().toISOString();
    updateItems((current) => current.map((entry) => (
      entry.id === itemId ? { ...entry, read_at: optimisticAt } : entry
    )));
    publishUnreadCount(Math.max(0, unreadCountRef.current - 1));

    try {
      const response = await fetch(`/api/rss/items/${itemId}/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewed: true }),
      });
      const result = await response.json().catch(() => null) as { readAt?: string } | null;
      if (!response.ok) throw new Error("view_failed");
      const readAt = result?.readAt || optimisticAt;
      updateItems((current) => current.map((entry) => (
        entry.id === itemId ? { ...entry, read_at: readAt } : entry
      )));
    } catch {
      const latest = itemsRef.current.find((entry) => entry.id === itemId);
      if (latest?.read_at === optimisticAt && latest.opportunity_state == null) {
        updateItems((current) => current.map((entry) => (
          entry.id === itemId ? { ...entry, read_at: null } : entry
        )));
        publishUnreadCount(unreadCountRef.current + 1);
      }
    } finally {
      viewedInFlightRef.current.delete(itemId);
    }
  }, [publishUnreadCount, updateItems]);

  const changeChannel = (nextChannelId: number) => {
    if (nextChannelId === channelId) return;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    if (refreshInterval.current) clearInterval(refreshInterval.current);
    setChannelId(nextChannelId);
    const params = new URLSearchParams(searchParams.toString());
    params.set("channel", String(nextChannelId));
    router.replace(`/app/rss?${params.toString()}`);
    void startAutomaticMonitoring(nextChannelId);
    refreshInterval.current = setInterval(() => void loadData(nextChannelId), 30_000);
  };

  const updateState = async (item: LegalItem, nextState: OpportunityState) => {
    if (stateItemId != null) return;
    const previous = item.opportunity_state;
    const previousReadAt = item.read_at;
    const wasUnread = legalOpportunityVisualState(item) === "new" && !viewedInFlightRef.current.has(item.id);
    const optimisticAt = item.read_at || new Date().toISOString();
    setStateItemId(item.id);
    updateItems((current) => current.map((entry) => (
      entry.id === item.id
        ? { ...entry, opportunity_state: nextState, read_at: optimisticAt }
        : entry
    )));
    if (wasUnread) publishUnreadCount(Math.max(0, unreadCountRef.current - 1));
    try {
      const response = await fetch(`/api/rss/items/${item.id}/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: nextState }),
      });
      const result = await response.json().catch(() => null) as { readAt?: string } | null;
      if (!response.ok) throw new Error("state_failed");
      updateItems((current) => current.map((entry) => (
        entry.id === item.id ? { ...entry, read_at: result?.readAt || optimisticAt } : entry
      )));
      if (nextState === "dismissed") {
        store.toast({ kind: "info", title: "Инфоповод скрыт", body: "Аврора учтёт этот выбор в текущей подборке." });
      }
    } catch {
      updateItems((current) => current.map((entry) => (
        entry.id === item.id
          ? {
              ...entry,
              opportunity_state: previous,
              read_at: entry.read_at === optimisticAt ? previousReadAt : entry.read_at,
            }
          : entry
      )));
      if (wasUnread) publishUnreadCount(unreadCountRef.current + 1);
      store.toast({ kind: "danger", title: "Не удалось сохранить выбор", body: "Проверьте соединение и попробуйте ещё раз." });
    } finally {
      setStateItemId(null);
    }
  };

  const markAllRead = async () => {
    if (markingAll || unreadCountRef.current === 0) return;
    const readAt = new Date().toISOString();
    const previousItems = itemsRef.current;
    const previousUnreadCount = unreadCountRef.current;
    setMarkingAll(true);
    updateItems((current) => current.map((item) => (
      legalOpportunityVisualState(item) === "new" ? { ...item, read_at: readAt } : item
    )));
    publishUnreadCount(0);

    try {
      const response = await fetch("/api/rss/read-all", { method: "POST" });
      if (!response.ok) throw new Error("read_all_failed");
      store.toast({
        kind: "success",
        title: "Все инфоповоды прочитаны",
        body: "Новые материалы в этом проекте отмечены как просмотренные.",
      });
    } catch {
      updateItems(previousItems);
      publishUnreadCount(previousUnreadCount);
      store.toast({
        kind: "danger",
        title: "Не удалось отметить материалы",
        body: "Проверьте соединение и попробуйте ещё раз.",
      });
    } finally {
      setMarkingAll(false);
    }
  };

  const openCreatePost = (item: EnrichedItem) => {
    void markViewed(item.id);
    if (item.post_id) {
      router.push(`/app/calendar#calendar-real-${item.post_id}`);
      return;
    }
    setPostDialogItem(item);
  };

  const createMaterial = async (
    item: LegalItem,
    destinationChannelId: number,
    variant: LegalOpportunityPostVariant,
  ) => {
    if (creatingItemId != null) return;
    setCreatingItemId(item.id);
    try {
      const response = await fetch(`/api/rss/items/${item.id}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: destinationChannelId, variant }),
      });
      const result = await response.json().catch(() => null) as
        | { ok?: boolean; draft?: { id?: number }; error?: string }
        | null;
      const draftId = Number(result?.draft?.id);
      if (!response.ok || !result?.ok || !Number.isSafeInteger(draftId) || draftId <= 0) {
        throw new Error(result?.error || "draft_failed");
      }
      await fetch(`/api/rss/items/${item.id}/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "used" }),
      }).catch(() => null);
      updateItems((current) => current.map((entry) => (
        entry.id === item.id ? { ...entry, opportunity_state: "used" } : entry
      )));
      setPostDialogItem(null);
      router.push(`/app/studio?draft=${draftId}&intent=create`);
    } catch {
      store.toast({
        kind: "danger",
        title: "Пост не подготовлен",
        body: "Исходный материал не изменён. Проверьте соединение и повторите действие.",
      });
    } finally {
      setCreatingItemId(null);
    }
  };

  const enriched = useMemo<EnrichedItem[]>(() => {
    const ranked = items
      .filter((item) => item.skip_reason !== "irrelevant" && item.skip_reason !== "paused")
      .filter((item) => isLikelyLegalOpportunity({
        title: item.title,
        summary: item.summary,
        feedTitle: item.feed_title,
      }))
      .map((item) => ({
        ...item,
        insight: classifyLegalOpportunity({
          title: item.title,
          summary: item.summary,
          feedTitle: item.feed_title,
          publishedAt: item.published_at,
          fetchedAt: item.fetched_at,
        }),
      }))
      .sort((left, right) => {
        const leftHasWork = left.post_id != null || left.opportunity_state === "used" || left.opportunity_state === "saved";
        const rightHasWork = right.post_id != null || right.opportunity_state === "used" || right.opportunity_state === "saved";
        return Number(rightHasWork) - Number(leftHasWork)
          || PRIORITY_ORDER[left.insight.priority] - PRIORITY_ORDER[right.insight.priority]
          || timeValue(right) - timeValue(left);
      });
    const representatives = new Map<string, EnrichedItem>();
    ranked.forEach((item) => {
      const fingerprint = legalOpportunityFingerprint(item);
      const current = representatives.get(fingerprint);
      if (!current || (
        legalOpportunityVisualState(current) === "new"
        && legalOpportunityVisualState(item) !== "new"
      )) {
        representatives.set(fingerprint, item);
      }
    });
    return Array.from(representatives.values());
  }, [items]);

  const practices = useMemo(() => [
    "Все практики",
    ...Array.from(new Set(enriched.map((item) => item.insight.practice))),
  ], [enriched]);

  const selectedPractice = practices.includes(practice) ? practice : "Все практики";
  const monitorChannels = useMemo(() => channels.filter((channel) => (
    channel.network === "tg" || channel.network === "vk"
  )), [channels]);

  const viewItems = useMemo(() => enriched.filter((item) => {
    if (selectedPractice !== "Все практики" && item.insight.practice !== selectedPractice) return false;
    if (view === "saved") return item.opportunity_state === "saved";
    if (view === "used") return item.opportunity_state === "used" || item.post_id != null || item.status === "posted";
    if (view === "hidden") return item.opportunity_state === "dismissed";
    return item.opportunity_state !== "dismissed";
  }), [enriched, selectedPractice, view]);

  useEffect(() => {
    const container = opportunityListRef.current;
    if (!container || typeof IntersectionObserver === "undefined") return;
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const existing = timers.get(entry.target);
        if (!entry.isIntersecting || entry.intersectionRatio < 0.6) {
          if (existing) clearTimeout(existing);
          timers.delete(entry.target);
          continue;
        }
        if (existing) continue;
        const itemId = Number((entry.target as HTMLElement).dataset.opportunityId);
        if (!Number.isSafeInteger(itemId) || itemId <= 0) continue;
        timers.set(entry.target, setTimeout(() => {
          timers.delete(entry.target);
          void markViewed(itemId);
        }, 900));
      }
    }, { threshold: [0.6] });

    const cards = container.querySelectorAll('[data-opportunity-state="new"]');
    cards.forEach((card) => observer.observe(card));
    return () => {
      observer.disconnect();
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, [markViewed, viewItems]);

  const activeFeeds = feeds.filter((feed) => feed.channel_id === channelId && feed.is_active);
  const updatingFeeds = activeFeeds.filter((feed) => Boolean(feed.last_fetched_at));
  const readyItems = enriched.filter((item) => item.post_id != null || item.opportunity_state === "used");
  const lastFetchedAt = activeFeeds
    .map((feed) => feed.last_fetched_at)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const selectedChannel = monitorChannels.find((channel) => channel.id === channelId) ?? null;
  const copy = VIEW_COPY[view];

  return (
    <>
    <AppShell
      title="Юридические инфоповоды"
      subtitle="Аврора следит за изменениями в праве и автоматически готовит актуальный контент для вашего проекта."
    >
      <div className="space-y-6">
        {loadError && (
          <Card className="flex flex-col gap-4 bg-danger-soft p-5 sm:flex-row sm:items-center sm:justify-between" role="alert">
            <div>
              <p className="text-[14px] font-bold text-danger-text">Не удалось обновить инфоповоды</p>
              <p className="mt-1 text-[13px] text-text-2">Проверьте соединение. Сохранённые материалы останутся на месте.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => channelId && void loadData(channelId, true)}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Повторить
            </Button>
          </Card>
        )}

        {!loading && monitorChannels.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Scale className="h-6 w-6" />}
              title="Подключите канал для готовых материалов"
              body="Аврора уже умеет находить юридические события. Подключите Telegram или VK, чтобы она адаптировала инфоповоды под вашу аудиторию."
              action={
                <Button variant="brand" size="sm" onClick={() => router.push("/app/settings?section=general")}>
                  Подключить канал
                </Button>
              }
            />
          </Card>
        ) : (
          <>
            <Card as="section" className="overflow-hidden bg-info-soft/70" aria-labelledby="automation-title">
              <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="flex items-start gap-4">
                  <span className="grid h-12 w-12 shrink-0 place-items-center rounded-sm bg-brand text-white shadow-glow" aria-hidden>
                    <Sparkles className="h-6 w-6" strokeWidth={2} />
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 id="automation-title" className="text-[18px] font-black text-text sm:text-[20px]">Аврора уже работает</h2>
                      <Badge tone={automationError ? "fire" : "success"}>
                        {automationError ? <RefreshCw className="h-3.5 w-3.5" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
                        {automationError ? "Обновление задерживается" : "Мониторинг включён"}
                      </Badge>
                    </div>
                    <p className="mt-1.5 max-w-2xl text-pretty text-[14px] leading-relaxed text-text-2">
                      Источники подключаются автоматически. Аврора убирает повторы, отмечает статус события и готовит лучший материал под выбранный канал.
                    </p>
                    <p role="status" aria-live="polite" className="nums mt-3 text-[12px] font-semibold text-text-3">
                      {preparing
                        ? "Проверяем свежие юридические события…"
                        : `${activeFeeds.length} ${plural(activeFeeds.length, "источник подключён", "источника подключены", "источников подключены")} · ${updatingFeeds.length} ${plural(updatingFeeds.length, "обновляется", "обновляются", "обновляются")} · ${enriched.length} ${plural(enriched.length, "инфоповод", "инфоповода", "инфоповодов")} в подборке`}
                    </p>
                  </div>
                </div>

                {monitorChannels.length > 1 && (
                  <label className="flex min-w-0 flex-col gap-1.5 text-[12px] font-bold text-text sm:min-w-64">
                    Канал для готового контента
                    <select
                      value={channelId ?? ""}
                      onChange={(event) => changeChannel(Number(event.target.value))}
                      className="h-11 w-full rounded-xs border border-line bg-surface px-3 text-base font-semibold text-text focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[14px]"
                    >
                      {monitorChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.title}</option>)}
                    </select>
                  </label>
                )}
              </div>

              <div className="grid border-t border-brand/10 bg-surface/55 sm:grid-cols-3">
                <div className="p-4 sm:border-r sm:border-brand/10">
                  <p className="text-[12px] font-bold tracking-[0.08em] text-text-3 uppercase">Новых для вас</p>
                  <p className="nums mt-1 text-[24px] font-black text-text">{unreadCount}</p>
                </div>
                <div className="border-t border-brand/10 p-4 sm:border-t-0 sm:border-r">
                  <p className="text-[12px] font-bold tracking-[0.08em] text-text-3 uppercase">Материалов готово</p>
                  <p className="nums mt-1 text-[24px] font-black text-text">{readyItems.length}</p>
                </div>
                <div className="border-t border-brand/10 p-4 sm:border-t-0">
                  <p className="text-[12px] font-bold tracking-[0.08em] text-text-3 uppercase">Последняя проверка</p>
                  <p className="nums mt-1 text-[16px] font-black text-text">
                    {lastFetchedAt ? fmtAgo(lastFetchedAt) : lastUpdatedAt ? fmtAgo(lastUpdatedAt.toISOString()) : "Запускается"}
                  </p>
                </div>
              </div>
            </Card>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
              <section aria-labelledby="opportunities-title" className="min-w-0 space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h2 id="opportunities-title" className="text-[20px] font-black text-text sm:text-[22px]">{copy.title}</h2>
                    <p className="mt-1 max-w-2xl text-pretty text-[13px] leading-relaxed text-text-3">{copy.body}</p>
                  </div>
                  <div className="flex flex-wrap items-end gap-2 sm:justify-end">
                    {unreadCount > 0 ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        loading={markingAll}
                        onClick={() => void markAllRead()}
                      >
                        <CheckCheck className="h-4 w-4" aria-hidden />
                        Отметить всё прочитанным
                      </Button>
                    ) : null}
                    {practices.length > 2 && (
                      <label className="flex min-w-0 flex-col gap-1.5 text-[12px] font-bold text-text sm:min-w-52">
                        Практика
                        <select
                          value={selectedPractice}
                          onChange={(event) => setPractice(event.target.value)}
                          className="h-11 rounded-xs border border-line bg-surface px-3 text-base font-semibold text-text focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[14px]"
                        >
                          {practices.map((item) => <option key={item} value={item}>{item}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                </div>

                {loading ? (
                  <div className="space-y-4" role="status" aria-label="Загружаем юридические инфоповоды">
                    {[0, 1, 2].map((index) => <div key={index} className="skeleton h-72 rounded-md" />)}
                  </div>
                ) : viewItems.length === 0 ? (
                  <Card>
                    <EmptyState
                      icon={view === "saved" ? <Bookmark className="h-6 w-6" /> : view === "used" ? <CalendarCheck2 className="h-6 w-6" /> : view === "hidden" ? <EyeOff className="h-6 w-6" /> : <Gavel className="h-6 w-6" />}
                      title={view === "saved" ? "Сохранённых инфоповодов пока нет" : view === "used" ? "Здесь появятся использованные материалы" : view === "hidden" ? "Скрытых инфоповодов нет" : "Аврора уже наблюдает за правом"}
                      body={view === "saved"
                        ? "Сохраняйте интересные события из персональной подборки — они останутся здесь."
                        : view === "used"
                          ? "После подготовки поста инфоповод автоматически переместится в этот раздел."
                          : view === "hidden"
                            ? "Скрытые материалы появятся здесь. Любой инфоповод можно вернуть в основную подборку."
                          : "Новых достаточно сильных событий пока нет. Аврора продолжает проверку и добавит их сюда автоматически."}
                      action={view !== "for-you" ? (
                        <Button variant="brand" size="sm" onClick={() => router.push(channelId ? `/app/rss?channel=${channelId}` : "/app/rss")}>
                          Открыть подборку
                        </Button>
                      ) : undefined}
                    />
                  </Card>
                ) : (
                  <div ref={opportunityListRef} className="space-y-4">
                    {viewItems.map((item) => (
                      <OpportunityCard
                        key={item.id}
                        item={item}
                        busy={creatingItemId === item.id}
                        stateBusy={stateItemId === item.id}
                        onCreate={openCreatePost}
                        onState={(selected, state) => void updateState(selected, state)}
                        onViewed={(itemId) => void markViewed(itemId)}
                      />
                    ))}
                  </div>
                )}
              </section>

              <aside className="space-y-4 xl:sticky xl:top-6" aria-label="Готовые материалы и параметры подборки">
                <Card className="p-5">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-success-soft text-success-text">
                      <CalendarCheck2 className="h-5 w-5" aria-hidden />
                    </span>
                    <div>
                      <h2 className="text-[15px] font-black text-text">Готово к работе</h2>
                      <p className="mt-0.5 text-[12px] text-text-3">Посты из найденных событий</p>
                    </div>
                  </div>

                  {readyItems.length ? (
                    <ul className="mt-4 space-y-2">
                      {readyItems.slice(0, 4).map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => openCreatePost(item)}
                            className="group flex min-h-11 w-full items-center gap-3 rounded-xs px-2 py-2 text-left transition-colors duration-150 hover:bg-surface-inset focus-visible:ring-4 focus-visible:ring-brand/15"
                          >
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-success-text" aria-hidden />
                            <span className="min-w-0 flex-1 line-clamp-2 text-[12px] font-semibold leading-snug text-text-2 group-hover:text-text">
                              {item.insight.title}
                            </span>
                            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-4 text-[13px] leading-relaxed text-text-3">
                      Аврора автоматически добавит сюда материалы после обработки свежих событий.
                    </p>
                  )}
                </Card>

                <Card className="p-5">
                  <div className="flex items-center gap-2 text-text-2">
                    <Target className="h-4 w-4" aria-hidden />
                    <h2 className="text-[14px] font-black text-text">Подборка для проекта</h2>
                  </div>
                  <p className="mt-3 text-[13px] leading-relaxed text-text-2">
                    {selectedChannel
                      ? `Аврора адаптирует найденные события под канал «${selectedChannel.title}» и его аудиторию.`
                      : "Аврора использует профиль проекта и аудиторию подключённого канала."}
                  </p>
                  <Link
                    href="/app/settings?section=posts"
                    className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-brand underline-offset-4 hover:underline focus-visible:rounded-xs focus-visible:ring-4 focus-visible:ring-brand/15"
                  >
                    Настроить профиль контента
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                </Card>
              </aside>
            </div>
          </>
        )}
      </div>
    </AppShell>
    <OpportunityPostDialog
      key={postDialogItem?.id ?? "closed"}
      target={postDialogItem ? {
        id: postDialogItem.id,
        title: postDialogItem.insight.title,
      } satisfies OpportunityPostDialogTarget : null}
      channels={channels as RealChannel[]}
      defaultChannelId={channelId}
      busy={creatingItemId === postDialogItem?.id}
      onClose={() => {
        if (creatingItemId == null) setPostDialogItem(null);
      }}
      onConfirm={(destinationChannelId, variant) => {
        if (postDialogItem) void createMaterial(postDialogItem, destinationChannelId, variant);
      }}
    />
    </>
  );
}

function LegalOpportunitiesFallback() {
  return (
    <AppShell
      title="Юридические инфоповоды"
      subtitle="Аврора следит за изменениями в праве и автоматически готовит актуальный контент для вашего проекта."
    >
      <div className="space-y-6" aria-busy="true" aria-label="Загружаем юридические инфоповоды">
        <Card className="overflow-hidden">
          <div className="animate-pulse space-y-4 p-6 motion-reduce:animate-none">
            <div className="h-6 w-56 rounded-xs bg-surface-inset" />
            <div className="h-4 max-w-2xl rounded-xs bg-surface-inset" />
            <div className="grid gap-3 pt-4 sm:grid-cols-3">
              <div className="h-20 rounded-sm bg-surface-inset" />
              <div className="h-20 rounded-sm bg-surface-inset" />
              <div className="h-20 rounded-sm bg-surface-inset" />
            </div>
          </div>
        </Card>
        <span className="sr-only" role="status">Загружаем юридические инфоповоды…</span>
      </div>
    </AppShell>
  );
}

export default function LegalOpportunitiesPage() {
  return (
    <Suspense fallback={<LegalOpportunitiesFallback />}>
      <LegalOpportunitiesScreen />
    </Suspense>
  );
}
