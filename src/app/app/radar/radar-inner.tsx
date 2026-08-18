"use client";

// Гибридный поиск: локальная база отвечает сразу, внешний discovery работает в фоне.
// В карточки попадают только URL, которые воркер повторно проверил на публичной t.me/s.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkPlus,
  CheckCircle2,
  ExternalLink,
  Eye,
  Heart,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from "lucide-react";

import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input, Tabs } from "@/components/ui/primitives";
import { useStore } from "@/lib/store";
import { cn, fmtAgo, fmtCompact, fmtNum, plural } from "@/lib/utils";

type ResultKind = "channel" | "post" | "trend";
type ResultTab = "all" | ResultKind;

type SearchResult = {
  id: string;
  actionId: number | null;
  kind: ResultKind;
  origin: string;
  title: string | null;
  handle: string | null;
  description: string | null;
  text: string | null;
  url: string | null;
  postedAt: string | null;
  lastPostAt: string | null;
  verifiedAt: string | null;
  subscribers: number | null;
  postsPerWeek: number | null;
  views: number | null;
  reactions: number | null;
  indexedPostsCount: number | null;
  score: number;
  reason: string;
  verified: boolean;
};

type SearchRun = {
  id: number;
  status: "queued" | "running" | "ready" | "partial" | "failed";
  stage: "queued" | "discovering" | "verifying" | "ranking" | "ready" | "failed";
  progress: number;
  provider: string | null;
  localCount: number;
  externalCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  completedAt: string | null;
};

const RESULT_TABS: { value: ResultTab; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "channel", label: "Каналы" },
  { value: "post", label: "Посты" },
  { value: "trend", label: "Тренды" },
];

const KIND_LABELS: Record<ResultKind, string> = {
  channel: "Канал",
  post: "Пост",
  trend: "Тренд",
};

function mergeResults(current: SearchResult[], incoming: SearchResult[]) {
  const merged = new Map<string, SearchResult>();
  for (const item of [...current, ...incoming]) {
    const canonicalUrl = item.url
      ?.toLowerCase()
      .replace("https://t.me/s/", "https://t.me/")
      .replace(/\/$/u, "");
    const key = canonicalUrl || `${item.kind}:${item.id}`;
    const previous = merged.get(key);
    if (!previous) merged.set(key, item);
    else {
      const itemPriority = item.score * 10 + (item.kind === "trend" ? 2 : item.kind === "post" ? 1 : 0);
      const previousPriority = previous.score * 10 + (previous.kind === "trend" ? 2 : previous.kind === "post" ? 1 : 0);
      const stronger = itemPriority > previousPriority ? item : previous;
      merged.set(key, {
        ...stronger,
        actionId: item.actionId ?? previous.actionId,
        verified: item.verified || previous.verified,
      });
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

function runMessage(run: SearchRun) {
  if (run.status === "partial") return run.errorMessage || "Интернет-поиск недоступен. Показываю результаты из базы.";
  if (run.status === "failed") return run.errorMessage || "Не удалось расширить поиск. Локальные результаты сохранены.";
  if (run.status === "ready") {
    return run.externalCount > 0
      ? `Доступный открытый индекс и публичная история каналов проверены. Добавлено ${run.externalCount} ${plural(run.externalCount, "проверенный результат", "проверенных результата", "проверенных результатов")}.`
      : "Доступный открытый индекс и публичная история каналов проверены, новых совпадений нет.";
  }
  if (run.stage === "verifying") return "Читаю всю доступную публичную историю найденных каналов. Результаты появляются по мере проверки…";
  if (run.stage === "ranking") return "Убираю дубли и ранжирую результаты…";
  if (run.stage === "discovering") return "Обхожу страницы открытого поиска по исходному запросу и близким формулировкам…";
  return "Запускаю расширенный поиск…";
}

function ResultCard({
  item,
  channelId,
  acting,
  completedAction,
  onAction,
}: {
  item: SearchResult;
  channelId: number | null;
  acting: boolean;
  completedAction: boolean;
  onAction: (item: SearchResult) => void;
}) {
  const action = item.kind === "channel" ? "add_competitor" : "save_idea";
  const canAct = Boolean(item.actionId && channelId);
  const date = item.postedAt || item.lastPostAt;
  return (
    <Card as="article" className="flex h-full min-w-0 flex-col p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={item.kind === "trend" ? "fire" : item.kind === "channel" ? "brand" : "neutral"}>
          {KIND_LABELS[item.kind]}
        </Badge>
        {item.verified && (
          <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-success-text">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
            Проверено
          </span>
        )}
        <span className="ml-auto nums text-[12px] font-semibold text-text-3">
          {Math.round(item.score)}/100
        </span>
      </div>

      <h3 className="mt-3 line-clamp-2 text-[16px] leading-snug font-bold text-text">
        {item.title || (item.handle ? `@${item.handle}` : "Telegram")}
      </h3>
      {item.handle && <p className="mt-0.5 break-all text-[13px] text-text-3">@{item.handle}</p>}

      {item.description && item.kind === "channel" && (
        <p className="mt-3 line-clamp-3 break-words text-[14px] leading-relaxed text-text-2">{item.description}</p>
      )}
      {item.text && item.kind !== "channel" && (
        <p className="mt-3 line-clamp-5 break-words whitespace-pre-wrap text-[14px] leading-relaxed text-text">
          {item.text}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-3">
        {item.subscribers != null && <span>{fmtCompact(item.subscribers)} подписчиков</span>}
        {item.postsPerWeek != null && <span>≈ {item.postsPerWeek.toLocaleString("ru-RU")} поста/нед.</span>}
        {item.kind === "channel" && item.indexedPostsCount != null && item.indexedPostsCount > 0 && (
          <span>{item.indexedPostsCount} {plural(item.indexedPostsCount, "пост изучен", "поста изучено", "постов изучено")}</span>
        )}
        {item.views != null && (
          <span className="inline-flex items-center gap-1">
            <Eye className="h-3.5 w-3.5" aria-hidden />
            {fmtNum(item.views)}
          </span>
        )}
        {item.reactions != null && (
          <span className="inline-flex items-center gap-1">
            <Heart className="h-3.5 w-3.5" aria-hidden />
            {fmtNum(item.reactions)}
          </span>
        )}
        {date && <span>{fmtAgo(date)}</span>}
      </div>

      <p className="mt-3 flex min-w-0 items-start gap-2 rounded-xs bg-surface-inset px-3 py-2 text-[12px] leading-relaxed text-text-2">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success-text" aria-hidden />
        <span className="min-w-0 break-words">{item.reason}</span>
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-[10px] px-2 text-[13px] font-semibold text-text-2 transition-colors duration-150 hover:bg-surface-inset hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            Открыть источник
          </a>
        )}
        {canAct && (
          <Button
            size="sm"
            variant="soft"
            loading={acting}
            disabled={completedAction}
            onClick={() => onAction(item)}
            className="ml-auto"
          >
            {completedAction ? (
              <CheckCircle2 className="h-4 w-4" aria-hidden />
            ) : action === "add_competitor" ? (
              <UserPlus className="h-4 w-4" aria-hidden />
            ) : (
              <BookmarkPlus className="h-4 w-4" aria-hidden />
            )}
            {completedAction
              ? action === "add_competitor" ? "Добавлен" : "Сохранено"
              : action === "add_competitor" ? "Добавить в конкуренты" : "Сохранить идею"}
          </Button>
        )}
      </div>
    </Card>
  );
}

export function RadarInner() {
  const store = useStore();
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [tab, setTab] = useState<ResultTab>("all");
  const [searchingLocal, setSearchingLocal] = useState(false);
  const [searched, setSearched] = useState(false);
  const [run, setRun] = useState<SearchRun | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, picked);

  const [actingId, setActingId] = useState<number | null>(null);
  const [completedActions, setCompletedActions] = useState<Set<number>>(new Set());
  const resultCursorRef = useRef(0);

  const pollRun = useCallback(async (runId: number) => {
    const params = new URLSearchParams({
      run: String(runId),
      after: String(resultCursorRef.current),
    });
    const response = await fetch(`/api/radar/search?${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error("poll_failed");
    const data = (await response.json()) as { run: SearchRun; results?: SearchResult[]; resultCursor?: number };
    setRun(data.run);
    if (Number.isSafeInteger(data.resultCursor) && Number(data.resultCursor) > resultCursorRef.current) {
      resultCursorRef.current = Number(data.resultCursor);
    }
    if (data.results?.length) setResults((current) => mergeResults(current, data.results ?? []));
    return data.run;
  }, []);

  const activeRunId = run && (run.status === "queued" || run.status === "running") ? run.id : null;
  useEffect(() => {
    if (!activeRunId) return;
    let stopped = false;
    const check = async () => {
      try {
        const next = await pollRun(activeRunId);
        if (!stopped && (next.status === "ready" || next.status === "partial" || next.status === "failed")) {
          setSearchError(next.status === "failed" ? next.errorMessage : null);
        }
      } catch {
        if (!stopped) setSearchError("Не удалось обновить результаты. Повтори поиск.");
      }
    };
    const timer = window.setInterval(check, 1_800);
    void check();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeRunId, pollRun]);

  const startExternal = useCallback(async (value: string, force = false) => {
    if (force) resultCursorRef.current = 0;
    try {
      const response = await fetch("/api/radar/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ q: value, channelId, force }),
      });
      const data = (await response.json().catch(() => null)) as {
        run?: SearchRun;
        results?: SearchResult[];
        resultCursor?: number;
        error?: string;
      } | null;
      if (data?.results?.length) setResults((current) => mergeResults(current, data.results ?? []));
      if (data?.run) {
        setRun(data.run);
        if (Number.isSafeInteger(data.resultCursor)) resultCursorRef.current = Number(data.resultCursor);
      }
      if (!response.ok && data?.error !== "queue_unavailable") throw new Error(data?.error || "external_failed");
      if (!response.ok) setSearchError(data?.run?.errorMessage || "Поиск в интернете временно недоступен.");
    } catch {
      setSearchError("Не удалось расширить поиск. Локальные результаты остаются доступны.");
    }
  }, [channelId]);

  const doSearch = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const value = query.trim();
    if (searchingLocal) return;
    if (value.length < 2) {
      setQueryError("Введи тему минимум из двух символов.");
      return;
    }
    setQueryError(null);
    setSearchingLocal(true);
    setSearched(true);
    setSubmittedQuery(value);
    setResults([]);
    resultCursorRef.current = 0;
    setRun(null);
    setSearchError(null);
    setTab("all");
    try {
      const params = new URLSearchParams({ q: value });
      if (channelId) params.set("channel", String(channelId));
      const response = await fetch(`/api/radar/search?${params}`, { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as {
        results?: SearchResult[];
        run?: SearchRun | null;
        resultCursor?: number;
        shouldExpand?: boolean;
        error?: string;
      } | null;
      if (!response.ok || !data) throw new Error(data?.error || "local_failed");
      setResults(data.results ?? []);
      setRun(data.run ?? null);
      if (Number.isSafeInteger(data.resultCursor)) resultCursorRef.current = Number(data.resultCursor);
      if (data.shouldExpand) void startExternal(value);
    } catch {
      setSearchError("Не удалось выполнить поиск. Проверь соединение и попробуй ещё раз.");
    } finally {
      setSearchingLocal(false);
    }
  };

  const actOnResult = async (item: SearchResult) => {
    if (!item.actionId || !channelId || actingId) return;
    setActingId(item.actionId);
    try {
      const response = await fetch(`/api/radar/results/${item.actionId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: item.kind === "channel" ? "add_competitor" : "save_idea",
          channelId,
        }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string; alreadyAdded?: boolean } | null;
      if (!response.ok) {
        const message = data?.error === "limit"
          ? "Достигнут лимит конкурентов. Удали ненужный канал и повтори."
          : "Не удалось выполнить действие. Попробуй ещё раз.";
        throw new Error(message);
      }
      setCompletedActions((current) => new Set(current).add(item.actionId as number));
      store.toast({
        kind: "success",
        title: item.kind === "channel"
          ? data?.alreadyAdded ? "Канал уже среди конкурентов" : "Канал добавлен в конкуренты"
          : "Идея сохранена в библиотеку",
      });
    } catch (error) {
      store.toast({
        kind: "danger",
        title: "Действие не выполнено",
        body: error instanceof Error ? error.message : "Попробуй ещё раз.",
      });
    } finally {
      setActingId(null);
    }
  };

  const filtered = useMemo(
    () => tab === "all" ? results : results.filter((item) => item.kind === tab),
    [results, tab],
  );
  const running = run?.status === "queued" || run?.status === "running";

  return (
    <div className="mx-auto w-full">
      <ChannelPicker
        channels={tgChannels}
        value={channelId}
        onChange={setPicked}
        label="Ищем для канала"
        className="mt-5"
      />

      <Card className="mt-5 p-4 sm:p-5">
        <form onSubmit={doSearch} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <label htmlFor="radar-query" className="mb-2 block text-[13px] font-semibold text-text-2">
              Что найти
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
              <Input
                id="radar-query"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (queryError) setQueryError(null);
                }}
                placeholder="Например: где искать клиентов юристу, строительство или @канал"
                className="pl-10"
                autoComplete="off"
                enterKeyHint="search"
                aria-invalid={queryError ? true : undefined}
                aria-describedby="radar-query-help"
              />
            </div>
          </div>
          <Button type="submit" variant="brand" loading={searchingLocal}>
            <Search className="h-4 w-4" aria-hidden />
            Найти
          </Button>
        </form>
        <p
          id="radar-query-help"
          aria-live="polite"
          className={cn("mt-3 text-[12px] leading-relaxed", queryError ? "font-medium text-danger-text" : "text-text-3")}
        >
          {queryError || "Пиши обычными словами. Аврора обойдёт доступную открытую выдачу, проверит близкие формулировки и прочитает публичную историю найденных Telegram-каналов. Для широких тем поиск может занять больше времени."}
        </p>
      </Card>

      {searched && (
        <section aria-labelledby="radar-results-title" className="mt-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 id="radar-results-title" className="break-words text-[16px] font-bold text-text">
                Результаты по запросу «{submittedQuery}»
              </h2>
              <p className="mt-0.5 text-[13px] text-text-3">
                {results.length} {plural(results.length, "совпадение", "совпадения", "совпадений")}
              </p>
            </div>
            <Tabs
              value={tab}
              onChange={setTab}
              items={RESULT_TABS}
              ariaLabel="Фильтр результатов поиска"
              idPrefix="radar-results-tab"
              controls="radar-results-panel"
              className="ml-auto max-w-full overflow-x-auto"
            />
          </div>

          <div role="status" aria-live="polite" aria-atomic="true">
            {run && (
              <div
                className={cn(
                  "mt-4 flex flex-wrap items-center gap-3 rounded-md px-4 py-3 text-[13px] font-medium",
                  run.status === "failed" || run.status === "partial"
                    ? "bg-fire-soft text-fire-text"
                    : run.status === "ready"
                      ? "bg-success-soft text-success-text"
                      : "bg-info-soft text-info-text",
                )}
              >
                {running ? <RefreshCw className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> : <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />}
                <span className="min-w-0 flex-1">{runMessage(run)}</span>
                {running && <span className="nums ml-auto shrink-0">{run.progress}%</span>}
                {run.status === "partial" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void startExternal(submittedQuery, true)}
                    className="ml-auto shrink-0"
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden />
                    Дочитать источники
                  </Button>
                )}
              </div>
            )}
          </div>

          {searchError && !running && (
            <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 rounded-md bg-danger-soft px-4 py-3">
              <p className="text-[13px] font-medium text-danger-text">{searchError}</p>
              <Button size="sm" variant="ghost" onClick={() => void startExternal(submittedQuery, true)} className="ml-auto">
                <RefreshCw className="h-4 w-4" aria-hidden />
                Повторить поиск в интернете
              </Button>
            </div>
          )}

          <div
            id="radar-results-panel"
            role="tabpanel"
            aria-labelledby={`radar-results-tab-${tab}`}
          >
            {searchingLocal && results.length === 0 ? (
              <div className="mt-4 grid gap-4 lg:grid-cols-2" aria-hidden>
                {[0, 1, 2, 3].map((item) => <div key={item} className="skeleton h-52 rounded-md" />)}
              </div>
            ) : filtered.length === 0 && !running ? (
              <Card className="mt-4">
                <EmptyState
                  icon={<Search className="h-5 w-5" aria-hidden />}
                  title={results.length ? "В этой категории совпадений нет" : `По запросу «${submittedQuery}» ничего не найдено`}
                  body={results.length
                    ? "Выбери вкладку «Все», чтобы вернуться к полной выдаче."
                    : "Аврора уже проверила исходный запрос и близкие формулировки. Можно уточнить тему или повторить проверку публичных источников."}
                  action={!results.length ? (
                    <Button variant="solid" onClick={() => void startExternal(submittedQuery, true)}>
                      <Sparkles className="h-4 w-4" aria-hidden />
                      Проверить публичные источники ещё раз
                    </Button>
                  ) : undefined}
                />
              </Card>
            ) : (
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                {filtered.map((item) => (
                  <ResultCard
                    key={item.id}
                    item={item}
                    channelId={channelId}
                    acting={actingId === item.actionId}
                    completedAction={Boolean(item.actionId && completedActions.has(item.actionId))}
                    onAction={actOnResult}
                  />
                ))}
              </div>
            )}
          </div>

        </section>
      )}

    </div>
  );
}
