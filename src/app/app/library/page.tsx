"use client";

// Библиотека — память конкретного канала, а не общий склад аккаунта.
// 1. «Референсы» — залетевшие посты конкурентов с наблюдаемым разбором механики.
// 2. «Коллекция» — свои удачные тексты, заметки и внутренние метки.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Bookmark,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  Flame,
  Heart,
  Link2,
  MessageSquareText,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { LibraryRegistryView } from "@/components/app/library-registry-view";
import {
  LibraryCardText,
  libraryCardContentId,
  toggleExpandedCardId,
} from "@/components/app/library-card-text";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input } from "@/components/ui/primitives";
import {
  appDraftActionHref,
  type DraftBackedAppAction,
} from "@/lib/app-routes";
import {
  createDraftClientKey,
  createServerDraft,
  DraftRequestError,
} from "@/lib/draft-client";
import {
  analyzeLibraryHit,
  buildLibraryDraftContext,
  normalizeLibraryLabels,
} from "@/lib/library";
import { useStore } from "@/lib/store";
import type { RealChannel } from "@/lib/types";
import { cn, fmtAgo, fmtNum } from "@/lib/utils";

/* ------------------------------------------------------------------ ТИПЫ */

type SavedPost = {
  id: number;
  channel_id: number;
  kind: "own" | "reference";
  source_post_id: string | number | null;
  source_competitor_id: string | number | null;
  source_title: string | null;
  source_url: string | null;
  text: string;
  note: string | null;
  tags: string[];
  created_at: string;
};
type Hit = {
  id: number;
  competitor_id: number;
  text: string;
  views: number | null;
  reactions: number | null;
  hit_ratio: string | number | null;
  posted_at: string;
  media: string | null;
  tg_msg_id: number | null;
  source_title: string | null;
  handle: string | null;
};
type Tab = "hits" | "posts";

const TABS: { key: Tab; label: string; description: string; icon: typeof Flame }[] = [
  {
    key: "hits",
    label: "Референсы",
    description: "Что уже сработало в нише и какую механику можно адаптировать без копирования.",
    icon: Flame,
  },
  {
    key: "posts",
    label: "Коллекция",
    description: "Сохранённые референсы и свои сильные тексты этого канала.",
    icon: Bookmark,
  },
];

// Карточки страницы поднимаются при наведении — единый жест рабочих экранов.
const HOVER =
  "transition-[box-shadow,border-color] duration-200 hover:border-line-strong hover:shadow-soft";

const ACTION_LINK =
  "relative inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[10px] px-3.5 py-2 text-[13px] font-semibold whitespace-nowrap text-text-2 transition-[transform,background-color,color] duration-200 hover:bg-surface-inset hover:text-text active:scale-[0.96]";

// Incremental rollout: the original reference list remains intact as a local fallback,
// while the production screen consumes the cohort-scored registry and snapshot exports.
const ANALYTICAL_REGISTRY_ENABLED = true;

function channelLabel(channel: RealChannel | null): string {
  if (!channel) return "Канал не выбран";
  return channel.title || (channel.handle ? `@${channel.handle.replace(/^@/u, "")}` : `Канал ${channel.id}`);
}

function networkLabel(channel: RealChannel | null): string {
  if (!channel) return "";
  if (channel.network === "tg") return "Telegram";
  if (channel.network === "vk") return "VK";
  if (channel.network === "youtube") return "YouTube";
  if (channel.network === "instagram") return "Instagram";
  if (channel.network === "tiktok") return "TikTok";
  if (channel.network === "linkedin") return "LinkedIn";
  return channel.network.toUpperCase();
}

/* ----------------------------------------------------------------- ЭКРАН */

function LibraryInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const s = useStore();

  const tabParam = searchParams.get("tab");
  const tab: Tab = tabParam === "posts" ? "posts" : "hits";
  const channelParam = Number(searchParams.get("channel")) || null;
  const activeChannels = useMemo(
    // PostgreSQL bigint приходит JSON-строкой, хотя доменный тип канала числовой.
    // Нормализуем на границе экрана, иначе URL `channel=18` не совпадает с id "18"
    // и переключатель каждый раз откатывается к первому каналу.
    () => s.realChannels
      .filter((channel) => channel.is_active)
      .map((channel) => ({ ...channel, id: Number(channel.id) }))
      .filter((channel) => Number.isSafeInteger(channel.id) && channel.id > 0),
    [s.realChannels],
  );
  const channelId = channelParam && activeChannels.some((channel) => channel.id === channelParam)
    ? channelParam
    : (activeChannels[0]?.id ?? null);
  const selectedChannel = activeChannels.find((channel) => channel.id === channelId) ?? null;
  const selectedChannelName = channelLabel(selectedChannel);

  // Старые закладки на удалённый раздел не должны оставлять несуществующую
  // вкладку в адресе: мягко возвращаем пользователя к референсам.
  useEffect(() => {
    if (tabParam !== "tags") return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "hits");
    router.replace(`/app/library?${params.toString()}`, { scroll: false });
  }, [router, searchParams, tabParam]);

  // Хиты ниши
  const [hits, setHits] = useState<Hit[]>([]);
  const [hitsLoading, setHitsLoading] = useState(true);
  const [hitsError, setHitsError] = useState<"no_channel" | "server" | null>(null);

  // Сохранённые посты и референсы
  const [posts, setPosts] = useState<SavedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState("");

  // Форма нового поста
  const [newText, setNewText] = useState("");
  const [newNote, setNewNote] = useState("");
  const [newTags, setNewTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingReferenceId, setSavingReferenceId] = useState<number | null>(null);
  const [expandedCardIds, setExpandedCardIds] = useState<Set<string>>(() => new Set());
  const [draftActionBusy, setDraftActionBusy] = useState<string | null>(null);
  const draftActionsRef = useRef<{
    promise: Promise<void> | null;
    clientKeys: Map<string, string>;
  }>({ promise: null, clientKeys: new Map() });
  const savedReferenceIds = useMemo(
    () => new Set(posts.filter((post) => post.kind === "reference" && post.source_post_id).map((post) => String(post.source_post_id))),
    [posts],
  );

  const loadHits = useCallback(async () => {
    if (!channelId) {
      setHits([]);
      setHitsError("no_channel");
      return;
    }
    try {
      const r = await fetch(`/api/library/hits?channel=${channelId}`, { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        const nextHits = Array.isArray(d.hits)
          ? d.hits
              .map((hit: Hit) => ({
                ...hit,
                id: Number(hit.id),
                competitor_id: Number(hit.competitor_id),
              }))
              .filter((hit: Hit) =>
                Number.isSafeInteger(hit.id) && hit.id > 0
                && Number.isSafeInteger(hit.competitor_id) && hit.competitor_id > 0,
              )
          : [];
        setHits(nextHits);
        setHitsError(null);
      } else if (r.status === 422) {
        setHitsError("no_channel");
      } else {
        setHitsError("server");
      }
    } catch {
      setHitsError("server");
    }
  }, [channelId, setHits, setHitsError]);

  const loadPosts = useCallback(async (query?: string) => {
    if (!channelId) {
      setPosts([]);
      return;
    }
    try {
      const params = new URLSearchParams({ channel: String(channelId) });
      if (query) params.set("q", query);
      const url = `/api/library/posts?${params.toString()}`;
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setPosts(d.posts ?? []);
      } else {
        setLoadError(true);
      }
    } catch { setLoadError(true); }
  }, [channelId, setLoadError, setPosts]);

  const reload = useCallback(() => {
    setLoadError(false);
    setLoading(true);
    setHitsLoading(true);
    setHits([]);
    setPosts([]);
    setHitsError(null);
    Promise.all([loadHits(), loadPosts()]).finally(() => {
      setLoading(false);
      setHitsLoading(false);
    });
  }, [
    loadHits,
    loadPosts,
    setHits,
    setHitsError,
    setHitsLoading,
    setLoadError,
    setLoading,
    setPosts,
  ]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  // Поиск по своим постам (debounce)
  useEffect(() => {
    if (tab !== "posts") return;
    const t = setTimeout(() => loadPosts(q.trim() || undefined), 300);
    return () => clearTimeout(t);
  }, [q, tab, loadPosts]);

  const savePost = async () => {
    const text = newText.trim();
    if (!text || !channelId) return;
    setSaving(true);
    try {
      const tags = normalizeLibraryLabels(newTags);
      const r = await fetch("/api/library/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, text, note: newNote.trim() || null, tags }),
      });
      if (r.ok) {
        setNewText("");
        setNewNote("");
        setNewTags("");
        await loadPosts();
        s.toast({ kind: "success", title: `Сохранено для «${selectedChannelName}»` });
      } else {
        s.toast({ kind: "danger", title: "Не удалось сохранить", body: "Проверь канал и попробуй ещё раз." });
      }
    } catch {
      s.toast({ kind: "danger", title: "Сетевая ошибка", body: "Текст остался в форме — повтори сохранение." });
    } finally {
      setSaving(false);
    }
  };

  const deletePost = async (id: number) => {
    const response = await fetch(`/api/library/posts?id=${id}`, { method: "DELETE" }).catch(() => null);
    if (response?.ok) setPosts((prev) => prev.filter((p) => p.id !== id));
    else s.toast({ kind: "danger", title: "Не удалось удалить запись" });
  };

  const saveReference = async (hit: Hit) => {
    if (!channelId || savingReferenceId !== null || savedReferenceIds.has(String(hit.id))) return;
    setSavingReferenceId(hit.id);
    try {
      const response = await fetch("/api/library/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, kind: "reference", sourcePostId: hit.id }),
      });
      if (!response.ok) throw new Error("Не удалось сохранить");
      await loadPosts();
      s.toast({ kind: "success", title: "Референс сохранён", body: `Он появился в коллекции «${selectedChannelName}».` });
    } catch {
      s.toast({ kind: "danger", title: "Не удалось сохранить референс", body: "Попробуй ещё раз." });
    } finally {
      setSavingReferenceId(null);
    }
  };

  const toggleCardText = useCallback((cardId: string) => {
    setExpandedCardIds((current) => toggleExpandedCardId(current, cardId));
  }, []);

  const openDraftAction = (
    action: DraftBackedAppAction,
    cardId: string,
    text: string,
    reference?: { sourcePostId: number | string; sourceLabel: string } | null,
  ) => {
    if (!channelId || draftActionsRef.current.promise) return;
    const actionKey = `${action}:${cardId}:channel:${channelId}`;
    const clientKey = draftActionsRef.current.clientKeys.get(actionKey) ?? createDraftClientKey();
    draftActionsRef.current.clientKeys.set(actionKey, clientKey);
    setDraftActionBusy(actionKey);

    const request = (async () => {
      try {
        const result = await createServerDraft(buildLibraryDraftContext({
          text,
          channelId,
          clientKey,
          reference,
        }));
        router.push(appDraftActionHref(action, result.draft.id));
      } catch (error) {
        s.toast({
          kind: "danger",
          title: "Черновик не создан",
          body:
            error instanceof DraftRequestError && error.kind === "offline"
              ? "Нет связи с сервером. Текст остался в библиотеке — повтори после восстановления сети."
              : "Контекст не удалось сохранить. Текст остался в библиотеке, действие можно безопасно повторить.",
        });
      } finally {
        draftActionsRef.current.promise = null;
        setDraftActionBusy(null);
      }
    })();
    draftActionsRef.current.promise = request;
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      s.toast({ kind: "info", title: "Скопировано" });
    } catch { /* ignore */ }
  };

  const hitRatio = (h: Hit) => {
    const n = Number(h.hit_ratio);
    return Number.isFinite(n) && n > 0 ? n.toFixed(1) : null;
  };

  const replaceContext = (next: { tab?: Tab; channelId?: number }) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next.tab ?? tab);
    const nextChannel = next.channelId ?? channelId;
    if (nextChannel) params.set("channel", String(nextChannel));
    else params.delete("channel");
    router.replace(`/app/library?${params.toString()}`, { scroll: false });
  };

  if (!s.realReady) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-12 w-full" />
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="skeleton h-52" />
          <div className="skeleton h-52" />
        </div>
      </div>
    );
  }

  if (!activeChannels.length) {
    return (
      <Card>
        <EmptyState
          icon={<Link2 className="h-6 w-6" />}
          title="Сначала подключи канал"
          body="Идеи и примеры хранят сильные тексты отдельно для каждого канала. После подключения здесь появится его собственная рабочая память."
          action={
            <Link href="/app/settings">
              <Button variant="solid" size="sm">
                <Link2 className="h-4 w-4" />
                Подключить канал
              </Button>
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <div className="mx-auto min-w-0 w-full max-w-[1180px]">
      {/* Контекст един для всех разделов: переключили канал — заменились все данные. */}
      <section className="flex min-w-0 flex-col gap-4 rounded-md border border-line bg-surface px-4 py-4 shadow-soft sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[12px] font-bold tracking-wide text-text-3 uppercase">
            <Radio className="h-4 w-4 text-success-text" aria-hidden />
            Память канала
          </p>
          <p className="mt-1 truncate text-[18px] font-extrabold text-text">{selectedChannelName}</p>
          <p className="mt-0.5 text-[12px] text-text-3">
            {networkLabel(selectedChannel)} · референсы и тексты не смешиваются с другими каналами
          </p>
        </div>
        <label className="min-w-0 sm:w-[280px]">
          <span className="sr-only">Выбранный канал</span>
          <select
            value={channelId ?? ""}
            onChange={(event) => replaceContext({ channelId: Number(event.target.value) })}
            className="min-h-11 w-full rounded-sm border border-line bg-surface-inset px-3 text-[14px] font-semibold text-text outline-none transition-colors hover:border-line-strong focus:border-brand"
          >
            {activeChannels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channelLabel(channel)} · {networkLabel(channel)}
              </option>
            ))}
          </select>
        </label>
      </section>

      {/* Ошибка загрузки своих данных */}
      {loadError && (
        <Card className="mt-5 p-4">
          <div className="flex items-center justify-between">
            <p className="text-[14px] text-text">Не удалось загрузить данные</p>
            <Button variant="soft" size="sm" onClick={reload}>
              <RefreshCw className="h-4 w-4" />
              Повторить
            </Button>
          </div>
        </Card>
      )}

      {/* Два назначения одной библиотеки: найти механику и сохранить лучшее. */}
      <div className="mt-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-md border border-line bg-surface p-2 md:grid-cols-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const count = t.key === "hits" ? hits.length : posts.length;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => replaceContext({ tab: t.key })}
              aria-current={tab === t.key ? "page" : undefined}
              className={cn(
                "flex min-h-[72px] min-w-0 w-full items-start gap-3 rounded-sm px-3 py-3 text-left transition-colors",
                tab === t.key ? "bg-info-soft text-info-text" : "text-text-2 hover:bg-surface-inset hover:text-text",
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-3 text-[13px] font-extrabold">
                  {t.label}
                  <span className="text-[11px] font-bold opacity-70">{count}</span>
                </span>
                <span className="mt-1 block text-[11px] leading-relaxed opacity-80">{t.description}</span>
              </span>
            </button>
          );
        })}
      </div>

      {tab === "hits" && ANALYTICAL_REGISTRY_ENABLED && channelId && (
        <LibraryRegistryView key={channelId} channelId={channelId} channelName={selectedChannelName} />
      )}

      {/* ============================ LEGACY FALLBACK ============================ */}
      {tab === "hits" && !ANALYTICAL_REGISTRY_ENABLED && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-[18px] font-extrabold text-text">Референсы канала</h2>
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-3">
                Только хиты конкурентов, привязанных к «{selectedChannelName}». Разбор показывает наблюдаемую механику — не выдумывает причину успеха.
              </p>
            </div>
            <Link href={`/app/competitors?channel=${channelId}`} className="text-[12px] font-bold text-info-text hover:underline">
              Настроить конкурентов
            </Link>
          </div>
          {hitsLoading ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-40" />)}
            </div>
          ) : hitsError === "no_channel" ? (
            <Card>
              <EmptyState
                icon={<Link2 className="h-6 w-6" />}
                title="Сначала подключи канал"
                body="Хиты ниши собираются по твоему каналу: разведка следит за конкурентами и находит посты, которые залетели сильнее их нормы."
                action={
                  <Link href="/app/settings">
                    <Button variant="solid" size="sm">
                      <Link2 className="h-4 w-4" />
                      Подключить канал
                    </Button>
                  </Link>
                }
              />
            </Card>
          ) : hitsError ? (
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <p className="text-[14px] text-text">Не удалось загрузить хиты</p>
                <Button
                  variant="soft"
                  size="sm"
                  onClick={() => { setHitsError(null); setHitsLoading(true); loadHits().finally(() => setHitsLoading(false)); }}
                >
                  <RefreshCw className="h-4 w-4" />
                  Повторить
                </Button>
              </div>
            </Card>
          ) : hits.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Flame className="h-6 w-6" />}
                title={`Для «${selectedChannelName}» референсов пока нет`}
                body="Добавь конкурентов именно этому каналу. Разведка сравнит каждый пост с обычным результатом его автора и принесёт сюда только подтверждённые хиты."
                action={
                  <Link href={`/app/competitors?channel=${channelId}`}>
                    <Button variant="solid" size="sm">
                      <Plus className="h-4 w-4" />
                      Добавить конкурентов
                    </Button>
                  </Link>
                }
              />
            </Card>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {hits.map((h) => {
                const ratio = hitRatio(h);
                const originalUrl = h.handle && h.tg_msg_id
                  ? `https://t.me/${h.handle.replace(/^@/u, "")}/${h.tg_msg_id}`
                  : null;
                const referenceSaved = savedReferenceIds.has(String(h.id));
                const cardId = `hit:${h.id}`;
                const contentId = libraryCardContentId("hit", h.id);
                const expanded = expandedCardIds.has(cardId);
                const sourceLabel = h.source_title || (h.handle ? `@${h.handle}` : "Конкурент");
                const reference = { sourcePostId: h.id, sourceLabel };
                const createActionKey = `create:${cardId}:channel:${channelId}`;
                const discussActionKey = `discuss:${cardId}:channel:${channelId}`;
                const analysis = analyzeLibraryHit({
                  text: h.text,
                  media: h.media,
                  hitRatio: ratio ? Number(ratio) : null,
                });
                return (
                  <Card key={h.id} className={cn("flex flex-col p-4", HOVER)}>
                    <div className="flex items-center gap-2 text-[12px]">
                      <p className="min-w-0 truncate font-semibold text-text">
                        {sourceLabel}
                      </p>
                      <span className="shrink-0 text-text-3">{fmtAgo(h.posted_at)}</span>
                    </div>
                    <LibraryCardText
                      className="mt-2"
                      contentId={contentId}
                      text={h.text}
                      expanded={expanded}
                      onToggle={() => toggleCardText(cardId)}
                    />
                    <div className="mt-3 rounded-sm bg-surface-inset px-3 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[11px] font-extrabold tracking-wide text-text-3 uppercase">Разбор механики</p>
                        <Badge tone="neutral">{analysis.format}</Badge>
                      </div>
                      <p className="mt-2 text-[12px] font-semibold leading-relaxed text-text">«{analysis.hook}»</p>
                      <div className="mt-2 grid gap-1.5">
                        {analysis.signals.map((signal) => (
                          <p key={signal} className="flex items-start gap-2 text-[11px] leading-relaxed text-text-2">
                            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success-text" aria-hidden />
                            {signal}
                          </p>
                        ))}
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-3 text-[12px] text-text-3">
                      {h.views != null && (
                        <span className="flex items-center gap-1">
                          <Eye className="h-3.5 w-3.5" aria-hidden />
                          {fmtNum(h.views)}
                        </span>
                      )}
                      {h.reactions != null && h.reactions > 0 && (
                        <span className="flex items-center gap-1">
                          <Heart className="h-3.5 w-3.5" aria-hidden />
                          {fmtNum(h.reactions)}
                        </span>
                      )}
                      {ratio && <Badge tone="fire">×{ratio} выше нормы</Badge>}
                      {h.media && h.media.includes("video") && <Badge tone="neutral">видео</Badge>}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
                      <Button
                        variant={referenceSaved ? "ghost" : "solid"}
                        size="sm"
                        onClick={() => saveReference(h)}
                        loading={savingReferenceId === h.id}
                        disabled={referenceSaved || (savingReferenceId !== null && savingReferenceId !== h.id)}
                      >
                        {savingReferenceId !== h.id && <Bookmark className={cn("h-3.5 w-3.5", referenceSaved && "fill-current")} aria-hidden />}
                        {referenceSaved ? "В коллекции" : "Сохранить"}
                      </Button>
                      <Button
                        variant="soft"
                        size="sm"
                        onClick={() => openDraftAction("create", cardId, h.text, reference)}
                        loading={draftActionBusy === createActionKey}
                        disabled={draftActionBusy !== null && draftActionBusy !== createActionKey}
                      >
                        {draftActionBusy !== createActionKey && <Sparkles className="h-3.5 w-3.5" aria-hidden />}
                        Создать пост
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openDraftAction("discuss", cardId, h.text, reference)}
                        loading={draftActionBusy === discussActionKey}
                        disabled={draftActionBusy !== null && draftActionBusy !== discussActionKey}
                      >
                        {draftActionBusy !== discussActionKey && <MessageSquareText className="h-3.5 w-3.5" aria-hidden />}
                        Обсудить
                      </Button>
                      {originalUrl && (
                        <a
                          href={originalUrl}
                          target="_blank"
                          rel="noreferrer"
                          className={ACTION_LINK}
                        >
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                          Открыть оригинал
                        </a>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyText(h.text)}
                        aria-label="Скопировать текст"
                        title="Скопировать текст"
                      >
                        <Copy className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ============================== КОЛЛЕКЦИЯ ============================== */}
      {tab === "posts" && (
        <div className="mt-5 space-y-4">
          <div>
            <h2 className="text-[18px] font-extrabold text-text">Коллекция канала</h2>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-3">
              Сохранённые референсы из разведки и собственные удачные заготовки для «{selectedChannelName}». Источник каждого чужого примера остаётся видимым.
            </p>
          </div>
          {/* Поиск */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск по тексту, источнику или меткам…"
              className="pl-9"
            />
          </div>

          {/* Ручная заготовка — вторичный сценарий; референсы сохраняются прямо из карточек. */}
          <Card className="p-4">
            <div className="mb-3 flex items-center gap-2">
              <MessageSquareText className="h-4 w-4 text-info-text" aria-hidden />
              <p className="text-[13px] font-extrabold text-text">Добавить свой текст вручную</p>
            </div>
            <textarea
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              placeholder="Вставь текст поста для сохранения…"
              rows={3}
              className="w-full resize-y rounded-sm border border-line bg-surface-inset px-3 py-2 text-[14px] text-text placeholder:text-text-3 focus:border-brand focus:outline-none"
            />
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Input
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="Почему сохраняем: сильный хук, кейс…"
              />
              <Input
                value={newTags}
                onChange={(e) => setNewTags(e.target.value)}
                        placeholder="Метки: пример, продажа, частые вопросы…"
              />
            </div>
            <div className="mt-3 flex justify-end">
              <Button variant="solid" size="sm" onClick={savePost} loading={saving} disabled={!newText.trim()}>
                <Plus className="h-4 w-4" />
                Сохранить для канала
              </Button>
            </div>
          </Card>

          {/* Список */}
          {loading ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {[0, 1].map((i) => <div key={i} className="skeleton h-24" />)}
            </div>
          ) : posts.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Bookmark className="h-5 w-5" />}
                title="Коллекция пока пустая"
                body={`Вернись в «Референсы» и нажми «Сохранить» на полезном примере — он останется в коллекции «${selectedChannelName}».`}
                action={
                  <Button variant="solid" size="sm" onClick={() => replaceContext({ tab: "hits" })}>
                    <Flame className="h-4 w-4" />
                    Открыть референсы
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {posts.map((p) => {
                const cardId = `post:${p.id}`;
                const contentId = libraryCardContentId("post", p.id);
                const expanded = expandedCardIds.has(cardId);
                const isReference = p.kind === "reference";
                const reference = isReference
                  ? {
                      sourcePostId: p.source_post_id ?? p.id,
                      sourceLabel: p.source_title || "Конкурент",
                    }
                  : null;
                const action = isReference ? "create" : "editor";
                const primaryActionKey = `${action}:${cardId}:channel:${channelId}`;
                const discussActionKey = `discuss:${cardId}:channel:${channelId}`;
                return (
                <Card key={p.id} className={cn("flex flex-col p-4", HOVER)}>
                  <div className="mb-2 flex items-center gap-2 text-[11px]">
                    <Badge tone={isReference ? "fire" : "neutral"}>
                      {isReference ? "Референс" : "Свой текст"}
                    </Badge>
                    {p.source_title && <span className="min-w-0 truncate font-semibold text-text-2">{p.source_title}</span>}
                  </div>
                  <LibraryCardText
                    contentId={contentId}
                    text={p.text}
                    expanded={expanded}
                    onToggle={() => toggleCardText(cardId)}
                  />
                  {p.note && (
                    <p className="mt-2 rounded-xs bg-surface-inset px-2.5 py-2 text-[11px] leading-relaxed text-text-2">
                      <span className="font-bold text-text">Зачем сохранено:</span> {p.note}
                    </p>
                  )}
                  {p.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {p.tags.map((t) => (
                        <Badge key={t} tone="neutral">{t}</Badge>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
                    <Button
                      variant="soft"
                      size="sm"
                      onClick={() => openDraftAction(action, cardId, p.text, reference)}
                      loading={draftActionBusy === primaryActionKey}
                      disabled={draftActionBusy !== null && draftActionBusy !== primaryActionKey}
                    >
                      {draftActionBusy !== primaryActionKey && isReference && (
                        <Sparkles className="h-3.5 w-3.5" aria-hidden />
                      )}
                      {isReference ? "Создать пост" : "Открыть в редакторе"}
                    </Button>
                    {isReference && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openDraftAction("discuss", cardId, p.text, reference)}
                        loading={draftActionBusy === discussActionKey}
                        disabled={draftActionBusy !== null && draftActionBusy !== discussActionKey}
                      >
                        {draftActionBusy !== discussActionKey && <MessageSquareText className="h-3.5 w-3.5" aria-hidden />}
                        Обсудить
                      </Button>
                    )}
                    {p.source_url && (
                      <a
                        href={p.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className={ACTION_LINK}
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                        Открыть оригинал
                      </a>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => copyText(p.text)}
                      aria-label="Скопировать текст"
                      title="Скопировать текст"
                    >
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <span className="ml-auto text-[12px] text-text-3">{fmtAgo(p.created_at)}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deletePost(p.id)}
                      className="text-danger-text"
                      aria-label="Удалить запись"
                      title="Удалить запись"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

    </div>
  );
}

export default function LibraryPage() {
  return (
    <AppShell title="Идеи и примеры" subtitle="Храни удачные тексты и используй их механику в новых публикациях.">
      <Suspense fallback={<div className="skeleton h-64" />}>
        <LibraryInner />
      </Suspense>
    </AppShell>
  );
}
