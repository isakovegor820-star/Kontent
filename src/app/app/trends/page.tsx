"use client";
import { useProjectFetch, useProjectCall } from "@/lib/use-project-transport";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  BarChart3,
  ExternalLink,
  Eye,
  FileText,
  Flame,
  Loader2,
  Radar,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { AppShell } from "@/components/app/shell";
import { ChannelPicker, channelName, useChannelChoice } from "@/components/app/channel-picker";
import { TrendStatistics, TrendMetrics, TrendDataDetails } from "@/app/app/trends/trend-statistics";
import { Button } from "@/components/ui/button";
import { Badge, Card, Checkbox, EmptyState, Input, Tabs } from "@/components/ui/primitives";
import { appDraftActionHref } from "@/lib/app-routes";
import { finalizeAiClientStream, parseAiStreamBuffer, type AiStreamEvent } from "@/lib/ai-stream";
import {
  acknowledgeAiTerminal as unscopedAcknowledgeAiTerminal,
  stableAiClientRequest,
  type AiClientRequestIdentity,
} from "@/lib/ai-client-idempotency";
import { createDraftClientKey, createServerDraft as unscopedCreateServerDraft, DraftRequestError } from "@/lib/draft-client";
import { isAbortError } from "@/lib/client-workspace-isolation";
import { useStore } from "@/lib/store";
import {
  createReviewedTrendDraft,
  TrendDraftReviewError,
} from "@/lib/trend-draft-review";
import { buildTrendReferenceDraft } from "@/lib/trend-reference";
import {
  parseTrendFeedScope,
  type TrendFeedScope,
} from "@/lib/trend-period";
import {
  TREND_STAT_PERIODS, parseTrendStatPeriod, parseTrendSort, TREND_PAGE_SIZE,
  type TrendStatSource, type TrendStatPeriod, type TrendSort, type TrendStatsData, type TrendFeedItem,
} from "@/lib/trend-statistics";
import { cn, fmtCompact, plural } from "@/lib/utils";

const EASE = [0.22, 1, 0.36, 1] as const;

type Item = TrendFeedItem;
type Data = TrendStatsData;

type TrendView = "feed" | "statistics";
type InternetSearchState = "idle" | "invalid" | "searching" | "ready" | "partial" | "error";

function trendStatSourceFromScope(scope: TrendFeedScope): TrendStatSource {
  return scope === "internet" ? "internet" : scope === "global" ? "collection" : "own";
}

function trendsInternetQueryFromUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("q")?.trim().slice(0, 200) ?? "";
}

function writeTrendsSearch(scope: TrendFeedScope, query = "", runId: number | null = null) {
  const url = new URL(window.location.href);
  if (scope === "niche") url.searchParams.delete("scope");
  else url.searchParams.set("scope", scope);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  if (scope === "internet" && runId) url.searchParams.set("run", String(runId));
  else url.searchParams.delete("run");
  window.history.replaceState(window.history.state, "", url);
}

interface RadarSearchRun {
  id: number;
  status: "queued" | "running" | "ready" | "partial" | "failed";
  stage: "queued" | "discovering" | "verifying" | "ranking" | "ready" | "failed";
  progress: number;
  errorMessage?: string | null;
}

const fmtRatio = (r: number) => `×${r.toFixed(1).replace(".", ",")}`;

const postDateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

const fmtPostDate = (iso: string) => postDateFormatter.format(new Date(iso));

/* -------------------------------------------------------------- ФОТО ПОСТА */
// Кадр показываем ЦЕЛИКОМ (object-contain), а не куском: у Telegram половина картинок
// вертикальные (600×800), и обрезка по широкой карточке съедала 84% кадра и растягивала
// остаток в 1.36 раза — отсюда и мыло. Поля вокруг закрываем размытой копией того же кадра,
// поэтому пустых поле́й тоже нет. Пока грузится — скелет, а не серая дыра.
// Ссылка CDN может протухнуть: тогда блок исчезает целиком, без битого значка.

function PostPhoto({ src, link }: { src: string; link: string }) {
  const [state, setState] = useState<"loading" | "ok" | "fail">("loading");
  const imgRef = useRef<HTMLImageElement>(null);

  // Картинка из кеша успевает загрузиться ДО того, как React навесит onLoad — тогда событие
  // не придёт никогда и кадр навсегда останется прозрачным (виден один размытый фон).
  // Поэтому при монтировании спрашиваем сам элемент, а не ждём события.
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete) setState(img.naturalWidth ? "ok" : "fail");
  }, []);

  if (state === "fail") return null;

  return (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Открыть изображение публикации в источнике"
      className={cn(
        "group relative block aspect-[4/3] overflow-hidden bg-surface-inset",
        state === "loading" && "skeleton",
      )}
    >
      <div
        className="absolute inset-0 scale-125 bg-cover bg-center opacity-35 blur-2xl"
        style={{ backgroundImage: `url("${src}")` }}
        aria-hidden
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- внешний CDN Telegram, next/image здесь только мешает */}
      <img
        ref={imgRef}
        src={src}
        alt=""
        loading="lazy"
        onLoad={() => setState("ok")}
        onError={() => setState("fail")}
        className={cn(
          "relative h-full w-full object-contain transition-all duration-300 group-hover:scale-[1.03]",
          state === "ok" ? "opacity-100" : "opacity-0",
        )}
      />
    </a>
  );
}

/* ------------------------------------------------------------------ КАРТОЧКА */

function ItemCard({
  item,
  draft,
  generating,
  generationError,
  generationLocked,
  requiresReview,
  reviewAcknowledged,
  transferring,
  onSnap,
  onReviewAcknowledged,
  onToComposer,
}: {
  item: Item;
  draft: string | undefined;
  generating: boolean;
  generationError: string | undefined;
  generationLocked: boolean;
  requiresReview: boolean;
  reviewAcknowledged: boolean;
  transferring: boolean;
  onSnap: () => void;
  onReviewAcknowledged: (checked: boolean) => void;
  onToComposer: () => void;
}) {
  const ratio = item.ratio;
  const median = item.median;
  const evaluated = item.isMature && ratio != null && median != null;
  const hot = ratio != null && evaluated && ratio >= 2;
  const snippet = (item.text || "").replace(/\s+/g, " ").trim();
  const hasGenerationTopic = Boolean(item.idea || snippet);

  return (
    <Card className="flex flex-col overflow-hidden">
      {item.photoUrl && <PostPhoto src={item.photoUrl} link={item.link} />}

      <div className="flex flex-1 flex-col p-5">
      <div className="flex flex-wrap items-center gap-2">
        {evaluated ? (
          <Badge tone={hot ? "fire" : "neutral"}>
            {hot && <Flame className="h-3 w-3" strokeWidth={2.5} aria-hidden />}
            {fmtRatio(ratio!)} к норме
          </Badge>
        ) : null}
        {item.media && item.media !== "text" && (
          <Badge tone="neutral">{item.media === "video" ? "Видео" : "Фото"}</Badge>
        )}
        <span className="truncate text-[13px] text-text-3">
          у «{item.competitorTitle || item.handle}»
        </span>
        <time dateTime={item.postedAt} className="ml-auto text-[12px] text-text-3">
          {fmtPostDate(item.postedAt)}
        </time>
      </div>

      <p className="mt-2.5 text-[12px] text-text-3" title={item.measuredAt ? `Счётчики собраны ${fmtPostDate(item.measuredAt)} МСК` : undefined}>
        {item.views == null ? "Просмотры недоступны" : `${item.views == null ? "—" : fmtCompact(item.views)} ${plural(item.views, "просмотр", "просмотра", "просмотров")}`}
        {item.reactions != null && ` · ${fmtCompact(item.reactions)} ${plural(item.reactions, "реакция", "реакции", "реакций")}`}
        {evaluated && ` · медиана ${fmtCompact(median!)} по ${item.baselinePosts} постам`}
      </p>

      {snippet ? (
        <p className="mt-3 line-clamp-4 text-[14px] leading-relaxed text-text-2">{snippet}</p>
      ) : (
        <p className="mt-3 text-[14px] text-text-3 italic">Пост без текста — только медиа.</p>
      )}

      {item.idea && (
        <div className="mt-3 rounded-md bg-surface-inset p-3.5">
          <p className="flex items-center gap-1.5 text-[12px] font-bold text-text-3 uppercase">
            <Sparkles className="h-3.5 w-3.5 text-brand" aria-hidden />
            {item.idea.topic || "Идея"}
          </p>
          {item.idea.hook && <p className="mt-1.5 text-[14px] leading-relaxed text-text-2">{item.idea.hook}</p>}
          {item.idea.structure && (
            <p className="mt-1.5 whitespace-pre-line text-[14px] leading-relaxed text-text-2">
              {item.idea.structure}
            </p>
          )}
        </div>
      )}

      {(draft || generating) && (
        <div className="mt-3 rounded-md border border-brand/20 bg-surface-inset p-3.5">
          <p className="flex items-center gap-1.5 text-[12px] font-bold text-text-3 uppercase">
            {generating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" aria-hidden />
            ) : (
              <Sparkles className="h-3.5 w-3.5 text-brand" aria-hidden />
            )}
            Твой пост на эту тему
          </p>
          <p className="mt-1.5 whitespace-pre-line text-[14px] leading-relaxed text-text-2">
            {draft || "…"}
          </p>
        </div>
      )}

      {generationError && !draft && !generating && (
        <div role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger-soft p-3.5">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-danger-text">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            Публикация не была завершена
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-text-2">{generationError}</p>
        </div>
      )}

      {draft && !generating && requiresReview && (
        <div className="mt-3 rounded-md border border-info-text/20 bg-info-soft p-3.5">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-info-text">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            Автоматическая смысловая проверка не выполнена
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-text-2">
            Сверь факты, цифры и формулировки с источником. Отметка будет сохранена на сервере
            для этой версии текста; после редактирования редактор запросит проверку снова.
          </p>
          <div className="mt-3">
            <Checkbox
              id={`trend-review-${item.id}`}
              checked={reviewAcknowledged}
              onChange={onReviewAcknowledged}
              label="Я сверил факты и смысл этого текста"
            />
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 pt-1">
        {draft && !generating ? (
          <Button
            size="sm"
            variant="brand"
            onClick={onToComposer}
            disabled={requiresReview && !reviewAcknowledged}
            loading={transferring}
          >
            {!transferring && <FileText className="h-4 w-4" aria-hidden />}
            {requiresReview ? "Подтвердить и открыть черновик" : "В черновик"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="brand"
            onClick={onSnap}
            loading={generating}
            disabled={generationLocked || !hasGenerationTopic}
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            {!hasGenerationTopic
              ? "Нет текста для темы"
              : generationError
                ? "Повторить создание"
                : "Создать публикацию"}
          </Button>
        )}
        <a
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-text-3 transition-colors hover:text-brand"
        >
          <Eye className="h-4 w-4" aria-hidden />
          {item.views == null ? "—" : fmtCompact(item.views)}
          <span className="inline-flex items-center gap-1">
            оригинал
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </span>
        </a>
      </div>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------- СТРАНИЦА */

export default function TrendsPage() {
  const createServerDraft = useProjectCall(unscopedCreateServerDraft);
  const acknowledgeAiTerminal = useProjectCall(unscopedAcknowledgeAiTerminal);
  const fetch = useProjectFetch();
  const router = useRouter();
  const store = useStore();
  const reduce = useReducedMotion();

  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<TrendView>(() => {
    if (typeof window === "undefined") return "feed";
    return new URLSearchParams(window.location.search).get("view") === "statistics"
      ? "statistics"
      : "feed";
  });
  const [scope, setScope] = useState<TrendFeedScope>(() => {
    if (typeof window === "undefined") return "niche";
    return parseTrendFeedScope(new URLSearchParams(window.location.search).get("scope"));
  });
  const [period, setPeriod] = useState<TrendStatPeriod>(() => typeof window === "undefined" ? "week"
    : parseTrendStatPeriod(new URLSearchParams(window.location.search).get("period")));
  const [sort, setSort] = useState<TrendSort>(() => typeof window === "undefined" ? "recent"
    : parseTrendSort(new URLSearchParams(window.location.search).get("sort")));
  const [internetQuery, setInternetQuery] = useState(trendsInternetQueryFromUrl);
  const [internetAppliedQuery, setInternetAppliedQuery] = useState(trendsInternetQueryFromUrl);
  const [internetSearchState, setInternetSearchState] = useState<InternetSearchState>("idle");
  const [internetSearchMessage, setInternetSearchMessage] = useState(
    "Публичные Telegram-публикации. Введи тему, чтобы начать поиск.",
  );
  const [checking, setChecking] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [draftFailures, setDraftFailures] = useState<Record<number, string>>({});
  const [draftReviews, setDraftReviews] = useState<Record<number, boolean>>({});
  const [draftAcknowledgements, setDraftAcknowledgements] = useState<Record<number, boolean>>({});
  const [generating, setGenerating] = useState<number | null>(null);
  const [transferring, setTransferring] = useState<number | null>(null);
  const draftClientKeysRef = useRef<Record<string, string>>({});
  const generationInFlightRef = useRef<number | null>(null);
  const generationRequestRef = useRef<Record<number, AiClientRequestIdentity>>({});
  const transferInFlightRef = useRef<Set<number>>(new Set());
  const refreshRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const internetQueryRef = useRef(trendsInternetQueryFromUrl());
  const runIdRef = useRef<number | null>(typeof window === "undefined" ? null
    : Number(new URLSearchParams(window.location.search).get("run")) || null);
  const offsetRef = useRef(0);
  const sortRef = useRef(sort);
  const searchSubmittingRef = useRef(false);
  const searchControllerRef = useRef<AbortController | null>(null);
  const internetSearchInputRef = useRef<HTMLInputElement>(null);
  const internetSearchTokenRef = useRef(0);
  const internetSearchRequestRef = useRef<{ fingerprint: string; key: string } | null>(null);

  const [picked, setPicked] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const value = Number(new URLSearchParams(window.location.search).get("channel"));
    return Number.isInteger(value) && value > 0 ? value : null;
  });

  // «Твоя ниша» — это ниша КАНАЛА: у кофейного и юридического каналов разные соседи и
  // разные нормы. Сервер это уже умеет, страница просто не спрашивала.
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, picked);

  const scopeRef = useRef(scope);
  const periodRef = useRef(period);
  const channelRef = useRef(channelId);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const pageLeavingRef = useRef(false);
  channelRef.current = channelId;

  const load = useCallback(async () => {
    if (searchSubmittingRef.current) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const ch = channelRef.current;
      if (!ch && scopeRef.current !== "global") {
        setData(null);
        setLoadError(false);
        return;
      }
      const params = new URLSearchParams({ source: trendStatSourceFromScope(scopeRef.current),
        period: periodRef.current, topic: internetQueryRef.current, sort: sortRef.current,
        offset: String(offsetRef.current) });
      if (ch) params.set("channel", String(ch));
      if (scopeRef.current === "internet" && runIdRef.current) params.set("run", String(runIdRef.current));
      const r = await fetch(`/api/trends/stats?${params}`, { cache: "no-store", signal: controller.signal });
      if (!r.ok) throw new Error(`trends: ${r.status}`);
      const next = (await r.json()) as Data;
      if (!controller.signal.aborted) {
        setData(next);
        setLoadError(false);
        if (scopeRef.current === "internet" && next.search && !searchSubmittingRef.current) {
          runIdRef.current = next.search.id;
          writeTrendsSearch("internet", internetQueryRef.current, next.search.id);
          const busy = next.search.status === "queued" || next.search.status === "running";
          setInternetSearchState(busy ? "searching" : next.search.status === "failed" ? "error" : next.search.status === "partial" ? "partial" : "ready");
          setInternetSearchMessage(busy
            ? `${next.search.stage === "verifying" ? "Проверяю публикации" : "Ищу источники"} · ${next.search.progress}%`
            : next.search.status === "partial" ? "Собрано частично. Некоторые источники недоступны или история ограничена."
              : next.search.status === "failed" ? "Не удалось завершить поиск. Можно повторить; доступные результаты сохранены."
                : next.summary.posts > 0 ? `Поиск завершён: ${next.summary.posts} ${plural(next.summary.posts, "публикация", "публикации", "публикаций")} за выбранный период.`
                  : "Поиск завершён. Публикаций за выбранный период не найдено.");
        }
      }
    } catch (error) {
      // Навигация и размонтирование могут прийти в тот же цикл событий, что и сетевой
      // TypeError. Даём cleanup выполнить abort, прежде чем показывать реальную ошибку.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const requestIsCurrent = requestRef.current === controller;
      const expectedCancellation = controller.signal.aborted
        || isAbortError(error)
        || !mountedRef.current
        || pageLeavingRef.current
        || !requestIsCurrent;
      if (!expectedCancellation) {
        console.error("[trends] load", error);
        setLoadError(true);
      }
    } finally {
      if (mountedRef.current && requestRef.current === controller && !searchSubmittingRef.current) setLoading(false);
    }
  }, [fetch]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load synchronizes the active project and server filters, including the no-channel state.
    void load();
  }, [load]);

  useEffect(() => {
    mountedRef.current = true;
    pageLeavingRef.current = false;
    const cancelPendingLoad = () => {
      pageLeavingRef.current = true;
      requestRef.current?.abort();
      searchControllerRef.current?.abort();
      searchSubmittingRef.current = false;
      internetSearchTokenRef.current += 1;
    };
    const resumePage = (event: PageTransitionEvent) => {
      pageLeavingRef.current = false;
      if (event.persisted) {
        setLoading(true);
        void load();
      }
    };
    window.addEventListener("beforeunload", cancelPendingLoad);
    window.addEventListener("pagehide", cancelPendingLoad);
    window.addEventListener("pageshow", resumePage);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("beforeunload", cancelPendingLoad);
      window.removeEventListener("pagehide", cancelPendingLoad);
      window.removeEventListener("pageshow", resumePage);
      cancelPendingLoad();
    };
  }, [load]);

  // Каналы приезжают асинхронно, и первый load уходит раньше них — без ?channel=.
  // Сервер в этом случае молча подставляет первый канал: сейчас это совпадает с тем, что
  // покажет селектор, но держаться на совпадении нельзя. Как только каналы приехали —
  // перезапрашиваем уже с явным каналом. Ровно один раз: дальше канал меняет switchChannel.
  const bootRef = useRef(false);
  useEffect(() => {
    if (!channelId || bootRef.current) return;
    bootRef.current = true;
    channelRef.current = channelId;
    load();
  }, [channelId, load]);

  // Переключение вкладки — это действие пользователя, а не эффект: меняем scope и грузим сразу.
  const switchScope = (v: TrendFeedScope) => {
    if (v === scopeRef.current) return;
    internetSearchTokenRef.current += 1;
    searchControllerRef.current?.abort();
    searchSubmittingRef.current = false;
    setInternetSearchState("idle");
    setInternetSearchMessage("Публичные Telegram-публикации. Введи тему, чтобы начать поиск.");
    runIdRef.current = null;
    offsetRef.current = 0;
    scopeRef.current = v;
    setScope(v);
    writeTrendsSearch(v, internetQueryRef.current);
    setLoading(true);
    setLoadError(false);
    setData(null);
    setDrafts({});
    setDraftFailures({});
    setDraftReviews({});
    setDraftAcknowledgements({});
    load();
  };

  const switchView = (next: TrendView) => {
    if (next === view) return;
    setView(next);
    const url = new URL(window.location.href);
    if (next === "statistics") url.searchParams.set("view", "statistics");
    else url.searchParams.delete("view");
    window.history.replaceState(window.history.state, "", url);
  };

  const applyLocalTopic = (query: string) => {
    internetQueryRef.current = query;
    setInternetAppliedQuery(query);
    runIdRef.current = null;
    offsetRef.current = 0;
    writeTrendsSearch(scopeRef.current, query);
    setLoading(true);
    setLoadError(false);
    setData(null);
    void load();
  };

  const clearInternetQuery = () => {
    internetSearchTokenRef.current += 1;
    searchControllerRef.current?.abort();
    searchSubmittingRef.current = false;
    internetSearchRequestRef.current = null;
    setInternetQuery("");
    setInternetSearchState("idle");
    setInternetSearchMessage("Публичные Telegram-публикации. Введи тему, чтобы начать поиск.");
    applyLocalTopic("");
  };

  const searchTopic = async (rawQuery: string) => {
    const query = rawQuery.replace(/\s+/gu, " ").trim().slice(0, 200);
    if (query.length < 2) {
      setInternetSearchState("invalid");
      setInternetSearchMessage("Введи минимум два символа.");
      internetSearchInputRef.current?.focus();
      return;
    }
    const destinationChannelId = Number(channelRef.current);
    if (!Number.isSafeInteger(destinationChannelId) || destinationChannelId <= 0) {
      setInternetSearchState("error");
      setInternetSearchMessage("Сначала выбери активный канал проекта.");
      internetSearchInputRef.current?.focus();
      return;
    }
    const fingerprint = `${destinationChannelId}:${query.toLocaleLowerCase("ru-RU")}:${periodRef.current}`;
    if (searchSubmittingRef.current && internetSearchRequestRef.current?.fingerprint === fingerprint) return;
    searchControllerRef.current?.abort();
    const searchController = new AbortController();
    searchControllerRef.current = searchController;
    searchSubmittingRef.current = true;
    requestRef.current?.abort();
    const token = ++internetSearchTokenRef.current;
    internetQueryRef.current = query;
    setInternetQuery(query);
    setInternetAppliedQuery(query);
    runIdRef.current = null;
    offsetRef.current = 0;
    writeTrendsSearch("internet", query);
    setData(null);
    setLoading(true);
    setLoadError(false);
    setInternetSearchState("searching");
    setInternetSearchMessage("Запускаю поиск публичных Telegram-публикаций…");
    if (internetSearchRequestRef.current?.fingerprint !== fingerprint) {
      internetSearchRequestRef.current = { fingerprint, key: crypto.randomUUID() };
    }
    try {
      const response = await fetch("/api/radar/search", {
        method: "POST", signal: searchController.signal,
        headers: { "content-type": "application/json", "idempotency-key": internetSearchRequestRef.current.key },
        body: JSON.stringify({ q: query, channelId: destinationChannelId, scope: "telegram", period: periodRef.current, force: true }),
      });
      const payload = await response.json().catch(() => null) as { run?: RadarSearchRun | null } | null;
      if (internetSearchTokenRef.current !== token) return;
      if (!payload?.run || (!response.ok && payload.run.status !== "failed")) throw new Error("search_unavailable");
      internetSearchRequestRef.current = null;
      runIdRef.current = payload.run.id;
      writeTrendsSearch("internet", query, payload.run.id);
      searchSubmittingRef.current = false;
      await load();
    } catch {
      if (internetSearchTokenRef.current !== token) return;
      setInternetSearchState("error");
      setInternetSearchMessage("Поиск не подтвердил запуск. Повтори запрос.");
      setLoading(false);
    } finally {
      if (internetSearchTokenRef.current === token) searchSubmittingRef.current = false;
    }
  };

  const searchInternet = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (scopeRef.current === "internet") void searchTopic(internetQuery);
    else applyLocalTopic(internetQuery.trim().slice(0, 200));
  };

  const switchPeriod = (value: TrendStatPeriod) => {
    if (value === periodRef.current) return;
    periodRef.current = value;
    setPeriod(value);
    offsetRef.current = 0;
    const url = new URL(window.location.href);
    url.searchParams.set("period", value);
    window.history.replaceState(window.history.state, "", url);
    if (scopeRef.current === "internet" && internetQueryRef.current) {
      void searchTopic(internetQueryRef.current);
    } else {
      setLoading(true);
      setData(null);
      void load();
    }
  };

  const switchSort = (value: TrendSort) => {
    sortRef.current = value;
    setSort(value);
    offsetRef.current = 0;
    const url = new URL(window.location.href);
    url.searchParams.set("sort", value);
    window.history.replaceState(window.history.state, "", url);
    setLoading(true);
    void load();
  };

  // Смена канала — тоже действие пользователя, и ведёт себя так же: сбрасываем показанное
  // и грузим заново. Оставить старые идеи на экране нельзя — они от соседей другого канала.
  const switchChannel = (id: number) => {
    if (id === channelRef.current) return;
    internetSearchTokenRef.current += 1;
    searchControllerRef.current?.abort();
    searchSubmittingRef.current = false;
    channelRef.current = id;
    setPicked(id);
    runIdRef.current = null;
    offsetRef.current = 0;
    if (scopeRef.current === "internet") {
      internetQueryRef.current = "";
      internetSearchRequestRef.current = null;
      setInternetQuery("");
      setInternetAppliedQuery("");
      writeTrendsSearch("internet");
      setInternetSearchState("idle");
      setInternetSearchMessage("Публичные Telegram-публикации. Введи тему, чтобы начать поиск.");
    }
    const url = new URL(window.location.href);
    url.searchParams.set("channel", String(id));
    window.history.replaceState(window.history.state, "", url);
    setLoading(true);
    setLoadError(false);
    setData(null);
    setDrafts({});
    setDraftFailures({});
    setDraftReviews({});
    setDraftAcknowledgements({});
    load();
  };

  const pending = data?.status.pending ?? 0;
  const searchRunning = data?.search?.status === "queued" || data?.search?.status === "running";
  useEffect(() => {
    if (!pending && !searchRunning) return;
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [pending, searchRunning, load]);

  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      // Канал обязателен и здесь: «Проверить сейчас» на канале Б иначе обновило бы
      // соседей канала А (сервер молча взял бы самый ранний).
      const fingerprint = `${scopeRef.current}:${channelId ?? "global"}`;
      if (!refreshRequestRef.current || refreshRequestRef.current.fingerprint !== fingerprint) {
        refreshRequestRef.current = { fingerprint, key: crypto.randomUUID() };
      }
      const r = await fetch(
        `/api/trends?scope=${scopeRef.current}${channelId ? `&channel=${channelId}` : ""}`,
        {
          method: "POST",
          headers: { "idempotency-key": refreshRequestRef.current.key },
        },
      );
      const d = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; queued?: number } | null;
      if (r.status === 202 && d?.error === "request_in_progress") {
        store.toast({ kind: "info", title: "Проверка уже запускается", body: "Второй сбор не создан." });
        return;
      }
      if (!r.ok || !d) {
        if (d?.error !== "request_in_progress") refreshRequestRef.current = null;
        throw new Error(d?.error || `trends_refresh_${r.status}`);
      }
      if (d.error === "no_competitors") {
        refreshRequestRef.current = null;
        store.toast({
          kind: "info",
          title: "Пока не за кем следить",
          body: "Добавь хотя бы один канал конкурента в «Разведке» — дальше я сам.",
        });
      } else if (d.ok) {
        refreshRequestRef.current = null;
        store.toast({
          kind: "success",
          title: "Проверяю каналы",
          body: `Поставил в сбор ${d.queued} ${plural(d.queued ?? 0, "канал", "канала", "каналов")}. Экран обновится сам, когда проверка закончится.`,
        });
        await load();
      }
    } catch {
      store.toast({ kind: "danger", title: "Не получилось", body: "Проверь соединение и попробуй ещё раз." });
    } finally {
      setChecking(false);
    }
  };

  // Создание публикации: готовую идею воркера сначала показываем в карточке для ручной
  // проверки. Если идеи нет — пишем тем же движком (Д.8), потоком прямо в карточку.
  const snap = async (item: Item) => {
    if (process.env.NEXT_PUBLIC_TREND_REFERENCE_STUDIO === "disabled") {
      store.toast({
        kind: "danger",
        title: "Безопасный create-flow обязателен",
        body: "Операторский rollback отключён: исходный текст нельзя превращать в публикуемый черновик напрямую.",
      });
      return;
    }
    // Новый основной путь: сначала сохраняем принадлежавший пользователю reference-draft,
    // затем передаём в URL только его ID. Студия запускает адаптацию по механике источника.
    // Старый inline-flow оставлен только как мёртвый migration fallback: feature flag
    // теперь fail-closed выше и не может вернуть прямую публикацию исходного текста.
    if (process.env.NEXT_PUBLIC_TREND_REFERENCE_STUDIO !== "disabled") {
      if (generationInFlightRef.current !== null) return;
      const destinationChannelId = Number(channelId);
      if (!Number.isSafeInteger(destinationChannelId) || destinationChannelId <= 0) {
        store.toast({
          kind: "danger",
          title: "Некуда сохранить публикацию",
          body: "Сначала подключи или выбери канал — исходный тренд останется на месте.",
        });
        return;
      }

      generationInFlightRef.current = item.id;
      setGenerating(item.id);
      const key = `${destinationChannelId}:${item.id}:studio-reference`;
      const clientKey = (draftClientKeysRef.current[key] ??= createDraftClientKey());
      try {
        const result = await createServerDraft(buildTrendReferenceDraft({
          trendId: item.id,
          channelId: destinationChannelId,
          clientKey,
          sourceLabel: item.competitorTitle || `@${item.handle}`,
          scope,
          text: item.text,
          idea: item.idea ? {
            topic: item.idea.topic,
            hook: item.idea.hook,
            structure: item.idea.structure,
          } : null,
        }));
        router.push(appDraftActionHref("create", result.draft.id));
      } catch (error) {
        const emptyReference = error instanceof RangeError
          && error.message === "trend reference text is required";
        store.toast({
          kind: emptyReference ? "info" : "danger",
          title: emptyReference ? "Не вижу тему публикации" : "Контекст не сохранён",
          body: emptyReference
            ? "В карточке нет текста или идеи для адаптации. Открой оригинал либо выбери другой тренд."
            : error instanceof DraftRequestError && error.kind === "offline"
              ? "Нет связи с сервером. Карточка осталась на месте — повтори после восстановления сети."
              : "Карточка осталась на месте. Повтор использует тот же ключ и не создаст второй черновик.",
        });
      } finally {
        if (generationInFlightRef.current === item.id) generationInFlightRef.current = null;
        setGenerating(null);
      }
      return;
    }

    if (item.idea) {
      const text = [item.idea.hook, item.idea.structure].filter(Boolean).join("\n\n");
      setDrafts((drafts) => ({ ...drafts, [item.id]: text }));
      setDraftFailures((failures) => ({ ...failures, [item.id]: "" }));
      // Worker ideas are AI-authored too. They do not carry semantic provenance, so the
      // same human-review boundary applies instead of silently importing them as manual.
      setDraftReviews((reviews) => ({ ...reviews, [item.id]: true }));
      setDraftAcknowledgements((reviews) => ({ ...reviews, [item.id]: false }));
      return;
    }

    if (!item.text?.trim()) {
      const message = "В исходной публикации есть только медиа и нет текста, по которому можно определить тему. Открой оригинал или выбери текстовую карточку — лимит не списан.";
      setDraftFailures((failures) => ({ ...failures, [item.id]: message }));
      store.toast({ kind: "info", title: "Не вижу тему публикации", body: message });
      return;
    }
    const sourceText = item.text.replace(/\s+/g, " ").trim();

    // Only one paid generation may be started from this page at a time. The ref closes the
    // tiny gap before React renders the disabled state after a rapid second click.
    if (generationInFlightRef.current !== null) return;
    generationInFlightRef.current = item.id;
    setGenerating(item.id);
    setDrafts((d) => ({ ...d, [item.id]: "" }));
    setDraftFailures((failures) => ({ ...failures, [item.id]: "" }));
    setDraftReviews((reviews) => ({ ...reviews, [item.id]: true }));
    setDraftAcknowledgements((reviews) => ({ ...reviews, [item.id]: false }));
    try {
      const generationBody = {
        command: "write",
        input: sourceText.slice(0, 1800),
        surface: "trends",
        channelId,
        context:
          `У конкурента «${item.competitorTitle || item.handle}» вышел пост на эту тему` +
          (item.ratio != null ? ` и собрал ${fmtRatio(item.ratio)} к его норме.` : ".") +
          " Используй его только как сигнал темы. Напиши МОЙ самостоятельный пост: не копируй формулировки, выбери свой угол и не добавляй факты, которых нет в исходном материале или подтверждённых данных моего канала.",
      };
      const requestFingerprint = JSON.stringify(generationBody);
      const generationRequest = stableAiClientRequest(
        generationRequestRef.current[item.id],
        requestFingerprint,
      );
      generationRequestRef.current[item.id] = generationRequest;
      const r = await fetch("/api/ai/generate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": generationRequest.key,
        },
        body: requestFingerprint,
      });
      const responseRequestId = r.headers.get("x-ai-request-id") ?? undefined;
      const correlated = (message: string, requestId = responseRequestId) =>
        `${message}${requestId ? ` Номер запроса: ${requestId}` : ""}`;

      if (r.status === 429) {
        const message = "Генерации обновятся завтра. Пост можно написать руками — открой «Студию».";
        const recovery = correlated(message);
        store.toast({
          kind: "info",
          title: "Лимит на сегодня исчерпан",
          body: recovery,
        });
        setDraftFailures((failures) => ({ ...failures, [item.id]: recovery }));
        setDrafts((d) => ({ ...d, [item.id]: "" }));
        return;
      }
      if (!r.ok || !r.body) {
        const info = (await r.json().catch(() => null)) as
          { error?: string; retryable?: boolean; requestId?: string } | null;
        const message = info?.error === "brief_insufficient_facts"
          ? "Для заданных настроек не хватает подтверждённых фактов. Уточни тему или добавь факты в настройках Авроры."
          : info?.error === "post_settings_conflict"
            ? "Некоторые настройки поста противоречат друг другу. Исправь их в настройках Авроры и повтори."
            : info?.error === "request_result_unavailable"
              ? "Запрос был завершён раньше, но сохранённый результат недоступен. Не создавай новый ключ; передай номер запроса в поддержку."
              : "Генерация сейчас недоступна. Проверь подключение модели и повтори тот же запрос.";
        const recovery = correlated(message, info?.requestId);
        store.toast({
          kind: "info",
          title: "ИИ пока не подключён",
          body: recovery,
        });
        setDraftFailures((failures) => ({ ...failures, [item.id]: recovery }));
        setDrafts((d) => ({ ...d, [item.id]: "" }));
        return;
      }
      if (!r.headers.get("content-type")?.includes("application/x-ndjson")) {
        throw new Error("unconfirmed_ai_stream");
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalText = "";
      let failed = false;
      let failureCode = "";
      let failureRetryable = false;
      let validationReceived = false;
      let validationBlocked = false;
      let validationRequiresReview = true;
      let doneReceived = false;
      let terminalRequestId = responseRequestId;
      const applyEvent = (event: AiStreamEvent) => {
        terminalRequestId = event.requestId;
        if (event.type === "delta") {
          finalText += event.text;
          setDrafts((drafts) => ({ ...drafts, [item.id]: finalText }));
        } else if (event.type === "replace") {
          finalText = event.text;
          setDrafts((drafts) => ({ ...drafts, [item.id]: finalText }));
        } else if (event.type === "validation") {
          validationReceived = true;
          validationBlocked = event.status !== "passed";
          validationRequiresReview = event.requiresReview;
        } else if (event.type === "error") {
          failed = true;
          failureCode = event.code || event.error;
          failureRetryable = event.retryable === true;
        } else if (event.type === "done") {
          doneReceived = true;
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseAiStreamBuffer(buffer);
        buffer = parsed.rest;
        parsed.events.forEach(applyEvent);
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        parseAiStreamBuffer(`${buffer}\n`).events.forEach(applyEvent);
      }

      const completion = finalizeAiClientStream({
        text: finalText,
        failed,
        validationReceived,
        doneReceived,
        validationBlocked,
        validationRequiresReview,
      });
      if (completion.status !== "complete") {
        const rejected = failureCode === "factual_validation_failed" || failureCode === "post_validation_failed";
        const message = rejected
          ? "Черновик остановлен на проверке качества. Уточни тему или настройки и повтори тот же запрос: ключ сохранён."
          : failureRetryable
            ? "Связь прервалась до подтверждения результата. Состояние списания не угадываем: повтор с сохранённым ключом вернёт готовый результат или безопасно продолжит запрос."
            : "Сервер не подтвердил готовую публикацию. Повтори с сохранённым ключом, чтобы не запускать отдельное списание.";
        const recovery = correlated(message, terminalRequestId);
        setDrafts((drafts) => ({ ...drafts, [item.id]: "" }));
        setDraftFailures((failures) => ({ ...failures, [item.id]: recovery }));
        store.toast({ kind: "danger", title: "Публикация не создана", body: recovery });
        return;
      }

      try {
        await acknowledgeAiTerminal(generationRequest.key);
      } catch {
        const recovery = correlated(
          "Результат сохранён, но подтверждение списания не завершилось. Повтори тот же запрос — модель не будет вызвана заново.",
          terminalRequestId,
        );
        setDrafts((drafts) => ({ ...drafts, [item.id]: "" }));
        setDraftFailures((failures) => ({ ...failures, [item.id]: recovery }));
        store.toast({ kind: "danger", title: "Результат ещё не подтверждён", body: recovery });
        return;
      }

      setDrafts((drafts) => ({ ...drafts, [item.id]: completion.text }));
      setDraftFailures((failures) => ({ ...failures, [item.id]: "" }));
      delete generationRequestRef.current[item.id];
      // A competitor trend is never treated as an authoritative fact source. Even a
      // technically passed result stays behind the explicit human-review checkpoint.
      setDraftReviews((reviews) => ({ ...reviews, [item.id]: true }));
    } catch {
      const message = "Связь оборвалась до подтверждения результата. Состояние списания не угадываем; повтор использует сохранённый ключ и не создаёт отдельную генерацию.";
      store.toast({ kind: "danger", title: "Не получилось", body: message });
      setDrafts((d) => ({ ...d, [item.id]: "" }));
      setDraftFailures((failures) => ({ ...failures, [item.id]: message }));
    } finally {
      if (generationInFlightRef.current === item.id) generationInFlightRef.current = null;
      setGenerating(null);
      void store.refreshAiUsage();
    }
  };

  const toComposer = async (item: Item) => {
    if (transferInFlightRef.current.has(item.id)) return;
    const text = drafts[item.id]?.trim() ?? "";
    const acknowledged = draftAcknowledgements[item.id] === true;
    if (!text || !acknowledged) return;

    transferInFlightRef.current.add(item.id);
    setTransferring(item.id);
    try {
      const transferKey = `${channelId ?? "none"}:${item.id}`;
      const clientKey = (draftClientKeysRef.current[transferKey] ??= createDraftClientKey());
      const draft = await createReviewedTrendDraft({
        text,
        trendId: item.id,
        sourceLabel: item.competitorTitle || `@${item.handle}`,
        channelId,
        clientKey,
        humanAcknowledged: acknowledged,
      });
      router.push(`/app/composer?draft=${draft.id}`);
    } catch (error) {
      const noDestination = error instanceof TrendDraftReviewError
        && error.code === "destination_required";
      const conflict = error instanceof TrendDraftReviewError
        && error.code === "draft_conflict";
      const offline = error instanceof DraftRequestError && error.kind === "offline";
      store.toast({
        kind: "danger",
        title: noDestination
          ? "Некуда сохранить черновик"
          : conflict
            ? "Черновик уже изменён"
            : "Проверка не сохранилась",
        body: noDestination
          ? "Подключи активный Telegram-канал и повтори. Текст остаётся на этой странице."
          : conflict
            ? "Серверная версия отличается. Текст не перезаписан и публикация не разрешена."
            : offline
              ? "Нет связи с сервером. Текст и отметка остались здесь — повтори после восстановления сети."
              : "Сервер не подтвердил отметку для этой версии. Публикация остаётся заблокированной.",
      });
    } finally {
      transferInFlightRef.current.delete(item.id);
      setTransferring((current) => (current === item.id ? null : current));
    }
  };

  const items = useMemo(() => data?.items ?? [], [data]);
  const global = scope === "global";
  const internet = scope === "internet";
  const selectedChannel = tgChannels.find((channel) => channel.id === channelId) ?? null;
  const niche = data?.status.niche ?? null;
  const needsChannel = !global && !channelId;
  const busy = internet && (internetSearchState === "searching" || searchRunning);
  const sameQuery = internetQuery.trim().toLocaleLowerCase("ru-RU") === internetAppliedQuery.toLocaleLowerCase("ru-RU");

  return (
    <AppShell title="Тренды" subtitle="Найди тему. Посмотри публикации и их реальные показатели.">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <Tabs items={[{ value: "niche", label: "Мои конкуренты" }, { value: "internet", label: "Поиск по теме" }]}
            value={scope === "niche" ? "niche" : "internet"} onChange={(value) => switchScope(value)} ariaLabel="Режим трендов" />
          {!global && <ChannelPicker channels={tgChannels} value={channelId} onChange={switchChannel}
            label="Канал проекта" className="min-w-0 sm:max-w-xs" />}
        </div>
        <form onSubmit={searchInternet} className="mt-5" noValidate>
          <label htmlFor="internet-feed-search" className="sr-only">Тема публикаций</label>
          <div className="flex gap-2">
            <Input ref={internetSearchInputRef} id="internet-feed-search" type="search" autoComplete="off"
              value={internetQuery} onChange={(event) => { setInternetQuery(event.target.value); if (internetSearchState === "invalid") setInternetSearchState("idle"); }}
              placeholder={niche ? `Например: ${niche}` : "Какая тема тебя интересует?"}
              aria-describedby="internet-feed-search-status" aria-invalid={internetSearchState === "invalid" || undefined}
              className="min-w-0 flex-1" />
            <Button type="submit" variant="brand" disabled={needsChannel || (busy && sameQuery)}>
              {busy && sameQuery ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Search className="h-4 w-4" aria-hidden />}
              {internet ? sameQuery && data?.search && !busy ? "Обновить" : "Найти" : "Показать"}
            </Button>
          </div>
        </form>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Tabs items={(Object.keys(TREND_STAT_PERIODS) as TrendStatPeriod[]).map((value) => ({ value, label: TREND_STAT_PERIODS[value].label }))}
            value={period} onChange={switchPeriod} ariaLabel="Период публикаций" />
          {scope !== "niche" && <label className="flex min-w-0 items-center gap-2 text-[12px] text-text-3 sm:ml-auto">
            <span>Источники</span>
            <select aria-label="Источники поиска" value={scope} onChange={(event) => switchScope(event.target.value as TrendFeedScope)}
              className="min-h-9 min-w-0 rounded-md border border-line bg-surface px-2 text-[12px] font-medium text-text-2">
              <option value="internet">Открытые Telegram-каналы</option><option value="global">Подборка Авроры</option>
            </select>
          </label>}
          {internetAppliedQuery && <button type="button" onClick={clearInternetQuery} className="min-h-9 text-[12px] text-text-3 underline-offset-4 hover:underline">Сбросить тему</button>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-text-3">
          <p id="internet-feed-search-status" role="status" className={cn(
            internet && ["error", "invalid"].includes(internetSearchState) && "text-danger-text",
            internet && internetSearchState === "partial" && "text-warning-text",
          )}>
            {internet ? internetSearchMessage : global ? "Публикации из каналов, отобранных Авророй." : "Публикации добавленных тобой Telegram-конкурентов."}
          </p>
          {!internet && !needsChannel && <button type="button" onClick={() => void check()} disabled={checking}
            className="inline-flex min-h-8 items-center gap-1.5 font-medium text-brand">
            <RefreshCw className={cn("h-3 w-3", checking && "animate-spin")} aria-hidden />{checking ? "Обновляю…" : "Обновить источники"}
          </button>}
        </div>
      </Card>

      <div className="mt-5 grid min-w-0 grid-cols-1 gap-5" aria-busy={loading}>
        {needsChannel ? <Card className="py-4"><EmptyState icon={<Radar className="h-6 w-6" aria-hidden />}
          title="Выбери канал проекта" body="Подключи Telegram-канал, чтобы искать темы и следить за конкурентами в этом проекте." /></Card>
        : loadError ? <Card className="py-4"><EmptyState icon={<AlertTriangle className="h-6 w-6" aria-hidden />}
          title="Не удалось загрузить данные" body="Повтори загрузку: публикации и статистика появятся вместе."
          action={<Button variant="soft" onClick={() => { setLoading(true); setLoadError(false); void load(); }}>Повторить</Button>} /></Card>
        : loading ? <div className="grid gap-3"><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((n) => <div key={n} className="skeleton h-28 rounded-md" />)}</div><div className="skeleton h-80 rounded-md" /></div>
        : internet && !internetAppliedQuery ? <Card className="py-8"><EmptyState icon={<Search className="h-6 w-6" aria-hidden />}
          title="Начни с темы" body="Например, «ремонт квартиры» или «искусственный интеллект». Найдём публичные посты и посчитаем их показатели."
          action={niche ? <Button variant="soft" onClick={() => void searchTopic(niche)}>Искать тему канала</Button> : undefined} /></Card>
        : data ? <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[16px] font-semibold text-text">{internetAppliedQuery ? `Тема: ${internetAppliedQuery}` : "Все темы"}</h2>
            <span className="text-[11px] text-text-3">{data.sourceLabel}{selectedChannel && !global ? ` · ${channelName(selectedChannel)}` : ""} · {data.periodLabel}</span>
          </div>
          {data.status.error > 0 && <p className="text-[12px] text-warning-text">Не удалось обновить {data.status.error} {plural(data.status.error, "источник", "источника", "источников")}. Показаны доступные данные.</p>}
          {data.coverage.latestMeasurementAt && <p className="-mt-3 text-[11px] text-text-3">
            Счётчики собраны {fmtPostDate(data.coverage.latestMeasurementAt)} МСК{data.coverage.oldestMeasurementAt !== data.coverage.latestMeasurementAt ? "; у части публикаций данные старше" : ""}.
          </p>}
          <TrendMetrics data={data} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Tabs items={[{ value: "feed", label: "Публикации", icon: <FileText className="h-4 w-4" aria-hidden /> },
              { value: "statistics", label: "Статистика", icon: <BarChart3 className="h-4 w-4" aria-hidden /> }]}
              value={view} onChange={switchView} ariaLabel="Представление результатов" />
            {view === "feed" && data.summary.posts > 0 && <select aria-label="Порядок публикаций" value={sort}
              onChange={(event) => switchSort(event.target.value as TrendSort)} className="min-h-9 rounded-md border border-line bg-surface px-3 text-[12px] text-text-2">
              <option value="recent">Сначала новые</option><option value="views">По просмотрам</option><option value="ratio">Выше нормы канала</option>
            </select>}
          </div>
          {data.summary.posts === 0 ? <Card className="py-5"><EmptyState icon={busy ? <Loader2 className="h-6 w-6 animate-spin" aria-hidden /> : <Search className="h-6 w-6" aria-hidden />}
            title={busy ? "Собираем публикации" : internet && !data.search ? "Запусти поиск по этой теме" : "Публикаций за этот период нет"}
            body={busy ? "Проверенные результаты и статистика появятся автоматически." : scope === "niche" && data.status.competitors === 0
              ? "Добавь Telegram-каналы конкурентов, чтобы видеть их публикации." : "Попробуй другую формулировку, расширь период или обнови поиск."}
            action={scope === "niche" && data.status.competitors === 0 ? <Button variant="brand" onClick={() => router.push("/app/competitors")}>Добавить конкурента</Button> : undefined} /></Card>
          : view === "statistics" ? <TrendStatistics data={data} /> : <>
            <ul className="columns-1 gap-5 md:columns-2 xl:columns-3">
              {items.map((item, i) => <motion.li key={`${scope}:${item.id}`} className="mb-5 break-inside-avoid"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, ease: EASE, delay: Math.min(i * 0.03, 0.2) }}>
                <ItemCard item={item} draft={drafts[item.id]} generating={generating === item.id}
                  generationError={draftFailures[item.id]} generationLocked={generating !== null} requiresReview={draftReviews[item.id] === true}
                  reviewAcknowledged={draftAcknowledgements[item.id] === true} transferring={transferring === item.id} onSnap={() => snap(item)}
                  onReviewAcknowledged={(checked) => setDraftAcknowledgements((reviews) => ({ ...reviews, [item.id]: checked }))}
                  onToComposer={() => void toComposer(item)} />
              </motion.li>)}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3 text-[12px] text-text-3">
              <span>Показаны {data.pagination.offset + 1}–{data.pagination.offset + items.length} из {data.pagination.total}. Статистика учитывает все найденные публикации.</span>
              {(data.pagination.offset > 0 || data.pagination.hasMore) && <div className="flex gap-2">
                <Button size="sm" variant="soft" disabled={data.pagination.offset === 0} onClick={() => { offsetRef.current = Math.max(0, data.pagination.offset - TREND_PAGE_SIZE); setLoading(true); void load(); }}>Назад</Button>
                <Button size="sm" variant="soft" disabled={!data.pagination.hasMore} onClick={() => { offsetRef.current = data.pagination.offset + TREND_PAGE_SIZE; setLoading(true); void load(); }}>Далее</Button>
              </div>}
            </div>
          </>}
          <TrendDataDetails data={data} />
        </> : internetSearchState === "error" ? <Card className="py-4"><EmptyState icon={<AlertTriangle className="h-6 w-6" aria-hidden />}
          title="Поиск не запустился" body="Нажми «Найти», чтобы повторить запрос." /></Card> : null}
      </div>
    </AppShell>
  );
}
