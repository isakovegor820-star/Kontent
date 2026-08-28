"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Check,
  Database,
  ExternalLink,
  Globe2,
  Info,
  LibraryBig,
  RefreshCw,
  Search,
} from "lucide-react";

import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input, Tabs } from "@/components/ui/primitives";
import {
  TREND_STAT_PERIODS,
  TREND_STAT_SOURCES,
  type TrendStatPeriod,
  type TrendStatSource,
} from "@/lib/trend-statistics";
import { cn, fmtAgo, fmtCompact, plural } from "@/lib/utils";

type TrendStatsData = {
  source: TrendStatSource;
  sourceLabel: string;
  sourceDescription: string;
  period: TrendStatPeriod;
  periodLabel: string;
  topic: string;
  channelId: number | null;
  window: { from: string | null; to: string | null };
  comparison: { previousPosts: number; previousViews: number };
  summary: {
    posts: number;
    sources: number;
    views: number;
    reactions: number;
    avgViews: number;
    trends: number;
    engagementRate: number;
    postsChange: number | null;
    viewsChange: number | null;
  };
  series: { bucket: string; posts: number; views: number }[];
  topItems: {
    id: string;
    sourceTitle: string | null;
    text: string | null;
    url: string | null;
    postedAt: string | null;
    views: number;
    reactions: number;
    ratio: number | null;
    qualityScore: number | null;
    reason: string | null;
  }[];
};

type ChartMetric = "posts" | "views";

const SOURCE_ICONS = {
  own: Database,
  internet: Globe2,
  collection: LibraryBig,
} satisfies Record<TrendStatSource, typeof Database>;

const SOURCE_GUIDANCE: Record<TrendStatSource, { title: string; body: string }> = {
  own: {
    title: "Только выбранные тобой конкуренты",
    body: "Показываем публикации Telegram-каналов, добавленных в «Конкуренты» для выбранного канала. Сравнение × к норме появляется после 48 часов и минимум пяти зрелых публикаций источника.",
  },
  internet: {
    title: "Проверенная база твоих интернет-поисков",
    body: "Фильтр ниже ищет внутри уже найденных ссылок. Чтобы расширить базу, запусти новый поиск в ленте: Аврора найдёт открытые страницы и проверит публикации на t.me. Это не полный индекс Telegram.",
  },
  collection: {
    title: "Общая редакционная подборка",
    body: "Проверенные публичные Telegram-каналы, которые отобрала команда Авроры. Подборка одинакова для всех твоих каналов и сейчас сфокусирована на праве и ИИ.",
  },
};

function Change({
  value,
  current,
  previous,
}: {
  value: number | null;
  current: number;
  previous: number;
}) {
  if (previous === 0) {
    return (
      <span className={cn(
        "text-[11px] font-semibold",
        current > 0 ? "text-success-text" : "text-text-3",
      )}>
        {current > 0 ? "новая активность" : "без изменений"}
      </span>
    );
  }
  if (value == null) return <span className="text-[11px] text-text-3">сравнение недоступно</span>;
  const positive = value >= 0;
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn(
      "inline-flex items-center gap-1 text-[11px] font-semibold",
      positive ? "text-success-text" : "text-danger-text",
    )}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {positive ? "+" : ""}{value.toLocaleString("ru-RU")}% к прошлому периоду
    </span>
  );
}

function Metric({
  label,
  value,
  detail,
  change,
  featured = false,
}: {
  label: string;
  value: string;
  detail: string;
  change?: React.ReactNode;
  featured?: boolean;
}) {
  return (
    <Card className={cn("min-w-0 p-4", featured && "bg-brand-soft/55")}>
      <p className="text-[12px] font-semibold text-text-3">{label}</p>
      <p className="mt-1 nums truncate text-[24px] leading-tight font-bold text-text">{value}</p>
      {change ? <div className="mt-2">{change}</div> : <p className="mt-2 text-[11px] leading-snug text-text-3">{detail}</p>}
    </Card>
  );
}

function formatBucket(value: string, period: TrendStatPeriod) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return period === "day"
    ? new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(date);
}

function formatWindow(window: TrendStatsData["window"]) {
  const from = window.from ? new Date(window.from) : null;
  const to = window.to ? new Date(window.to) : null;
  if (!from || !to || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return null;
  const formatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
  return `${formatter.format(from)} — ${formatter.format(to)}`;
}

function ActivityChart({ data }: { data: TrendStatsData }) {
  const [metric, setMetric] = useState<ChartMetric>("posts");
  const max = Math.max(1, ...data.series.map((point) => point[metric]));
  const total = data.series.reduce((sum, point) => sum + point[metric], 0);
  const label = metric === "posts" ? "публикаций" : "просмотров";

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-bold text-text">Динамика по времени</h3>
          <p className="mt-1 text-[12px] text-text-3">
            {metric === "posts"
              ? "Когда выходили найденные публикации."
              : "Текущие просмотры публикаций, сгруппированные по дате выхода."}
          </p>
        </div>
        <Tabs
          items={[
            { value: "posts", label: "Публикации" },
            { value: "views", label: "Просмотры" },
          ]}
          value={metric}
          onChange={setMetric}
          ariaLabel="Показатель графика"
        />
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-3">
        <span className="nums text-[22px] font-bold text-text">{fmtCompact(total)}</span>
        <span className="text-[11px] text-text-3">{label} · {data.periodLabel.toLocaleLowerCase("ru-RU")}</span>
      </div>
      <div className="mt-3 flex h-36 items-end gap-1" aria-hidden="true">
        {data.series.map((point) => {
          const value = point[metric];
          return (
            <div
              key={point.bucket}
              className="group relative flex h-full min-w-0 flex-1 items-end"
              title={`${formatBucket(point.bucket, data.period)}: ${value.toLocaleString("ru-RU")} ${label}`}
            >
              <div
                className={cn(
                  "w-full rounded-t-[4px] bg-brand/30 transition-colors group-hover:bg-brand/65",
                  value === 0 && "bg-surface-inset",
                )}
                style={{ height: `${value === 0 ? 3 : Math.max(8, (value / max) * 100)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-text-3" aria-hidden="true">
        <span>{data.series[0] ? formatBucket(data.series[0].bucket, data.period) : "—"}</span>
        <span>{data.series.at(-1) ? formatBucket(data.series.at(-1)!.bucket, data.period) : "—"}</span>
      </div>

      <table className="sr-only">
        <caption>Динамика публикаций за {data.periodLabel.toLocaleLowerCase("ru-RU")}</caption>
        <thead><tr><th>Период</th><th>Публикации</th><th>Просмотры</th></tr></thead>
        <tbody>
          {data.series.map((point) => (
            <tr key={point.bucket}>
              <td>{formatBucket(point.bucket, data.period)}</td>
              <td>{point.posts}</td>
              <td>{point.views}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function SourceGuide({
  source,
  onOpenFeed,
}: {
  source: TrendStatSource;
  onOpenFeed?: (source: TrendStatSource) => void;
}) {
  const Icon = SOURCE_ICONS[source];
  const guidance = SOURCE_GUIDANCE[source];
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-md bg-surface-inset p-4 sm:flex-row sm:items-center">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface text-brand shadow-soft">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-text">{guidance.title}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-text-3">{guidance.body}</p>
      </div>
      {source === "own" ? (
        <Link href="/app/competitors" className={buttonClassName({ variant: "ghost", size: "sm", className: "shrink-0" })}>
          Настроить конкурентов
        </Link>
      ) : onOpenFeed ? (
        <Button variant="ghost" size="sm" className="shrink-0" onClick={() => onOpenFeed(source)}>
          {source === "internet" ? "Найти новые" : "Открыть подборку"}
        </Button>
      ) : null}
    </div>
  );
}

export function TrendStatistics({
  channelId,
  channelTopic,
  channelLabel,
  channelControl,
  source,
  initialTopic = "",
  onSourceChange,
  onOpenFeed,
}: {
  channelId: number | null;
  channelTopic?: string | null;
  channelLabel?: string | null;
  channelControl?: React.ReactNode;
  source: TrendStatSource;
  initialTopic?: string;
  onSourceChange: (source: TrendStatSource) => void;
  onOpenFeed?: (source: TrendStatSource) => void;
}) {
  const normalizedInitialTopic = initialTopic.trim().slice(0, 100);
  const [period, setPeriod] = useState<TrendStatPeriod>("week");
  const [topicInput, setTopicInput] = useState(normalizedInitialTopic);
  const [topic, setTopic] = useState(normalizedInitialTopic);
  const [data, setData] = useState<TrendStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (source !== "collection" && !channelId) {
      setData(null);
      setError(false);
      setLoading(false);
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(false);
    try {
      const params = new URLSearchParams({ source, period });
      if (channelId) params.set("channel", String(channelId));
      if (topic) params.set("topic", topic);
      const response = await fetch(`/api/trends/stats?${params}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("trend_stats_unavailable");
      const next = (await response.json()) as TrendStatsData;
      if (!controller.signal.aborted) setData(next);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }, [channelId, period, source, topic]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- загрузка зависит от выбранных серверных фильтров
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  const maxViews = useMemo(
    () => Math.max(0, ...(data?.topItems.map((item) => item.views) ?? [])),
    [data],
  );

  const applyTopic = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTopic(topicInput.trim().slice(0, 100));
  };

  const clearTopic = () => {
    setTopicInput("");
    setTopic("");
  };

  const activeTopic = topic || "все темы";
  const windowLabel = data ? formatWindow(data.window) : null;
  const trendMetricLabel = source === "internet" ? "Помечены как тренд" : "Выше нормы ×1,5";
  const trendMetricDetail = source === "internet"
    ? "Проверенные результаты с трендовым сигналом"
    : "Зрелые публикации относительно медианы канала";

  return (
    <section aria-labelledby="trend-statistics-title">
      <div className="max-w-3xl">
        <h2 id="trend-statistics-title" className="flex items-center gap-2 text-[19px] font-bold text-text">
          <BarChart3 className="h-5 w-5 text-brand" aria-hidden />
          Статистика трендов
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-text-3">
          Выбери базу, период и тему. Показатели ниже всегда относятся только к этой комбинации фильтров.
        </p>
      </div>

      <Card className="mt-5 p-4 sm:p-5">
        <fieldset>
          <legend className="mb-2 text-[12px] font-semibold text-text-3">1. Где смотрим</legend>
          <div className="grid gap-2 lg:grid-cols-3">
            {(Object.keys(TREND_STAT_SOURCES) as TrendStatSource[]).map((value) => {
              const item = TREND_STAT_SOURCES[value];
              const Icon = SOURCE_ICONS[value];
              const active = source === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSourceChange(value)}
                  className={cn(
                    "min-h-28 rounded-md border p-3.5 text-left transition-[background-color,border-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2",
                    active
                      ? "border-brand bg-brand-soft/55 shadow-soft"
                      : "border-line bg-surface text-text-2 hover:border-line-strong",
                  )}
                >
                  <span className="flex items-center gap-2 text-[13px] font-bold text-text">
                    <span className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full",
                      active ? "bg-brand text-white" : "bg-surface-inset text-text-2",
                    )}>
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    {item.label}
                    {active && <Check className="ml-auto h-4 w-4 text-brand" aria-hidden />}
                  </span>
                  <span className="mt-2 block text-[11px] leading-relaxed text-text-3">{item.description}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className={cn("mt-5 grid gap-5", source !== "collection" && "lg:grid-cols-[minmax(0,1fr)_auto]")}>
          {source !== "collection" && (
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-text-3">2. Канал</p>
              {channelControl}
              <p className="mt-2 text-[12px] leading-relaxed text-text-2">
                {channelId
                  ? <>Считаем базу для канала <strong className="text-text">{channelLabel || `№ ${channelId}`}</strong>.</>
                  : "Подключи Telegram-канал, чтобы разделить конкурентов и интернет-поиски по проектам."}
              </p>
            </div>
          )}

          <fieldset>
            <legend className="mb-2 text-[12px] font-semibold text-text-3">
              {source === "collection" ? "2. Период" : "3. Период"}
            </legend>
            <Tabs
              items={(Object.keys(TREND_STAT_PERIODS) as TrendStatPeriod[]).map((value) => ({
                value,
                label: TREND_STAT_PERIODS[value].label,
              }))}
              value={period}
              onChange={setPeriod}
              ariaLabel="Период статистики"
            />
          </fieldset>
        </div>

        <form onSubmit={applyTopic} className="mt-5">
          <label htmlFor="trend-stat-topic" className="mb-2 block text-[12px] font-semibold text-text-3">
            {source === "collection" ? "3. Тема" : "4. Тема"} <span className="font-normal">· необязательно</span>
          </label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              id="trend-stat-topic"
              type="search"
              autoComplete="off"
              value={topicInput}
              onChange={(event) => setTopicInput(event.target.value)}
              placeholder="Например: рыбалка, садоводство или банкротство"
              aria-describedby="trend-stat-topic-hint"
              className="min-w-0 sm:flex-1"
            />
            <Button type="submit" variant="primary" disabled={topicInput.trim().slice(0, 100) === topic}>
              <Search className="h-4 w-4" aria-hidden />
              Применить
            </Button>
            {topic && (
              <Button type="button" variant="secondary" onClick={clearTopic}>
                Сбросить тему
              </Button>
            )}
          </div>
          <p id="trend-stat-topic-hint" className="mt-2 text-[11px] leading-relaxed text-text-3">
            Тема фильтрует заголовки источников и тексты внутри выбранной базы; новый интернет-поиск здесь не запускается.
          </p>
        </form>

        {channelTopic && channelTopic.trim() && topic !== channelTopic.trim() && (
          <button
            type="button"
            onClick={() => {
              setTopicInput(channelTopic.trim());
              setTopic(channelTopic.trim());
            }}
            className="mt-2 min-h-8 text-left text-[12px] font-semibold text-brand underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Использовать тему канала: {channelTopic.trim()}
          </button>
        )}

        <SourceGuide source={source} onOpenFeed={onOpenFeed} />
      </Card>

      <div className="mt-5" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {Array.from({ length: 6 }, (_, index) => <div key={index} className="skeleton h-28 rounded-md" />)}
          </div>
        ) : source !== "collection" && !channelId ? (
          <Card className="py-4">
            <EmptyState
              icon={<Database className="h-6 w-6" aria-hidden />}
              title="Сначала подключи Telegram-канал"
              body="Канал нужен, чтобы данные конкурентов и интернет-поисков одного проекта не смешивались с другим."
            />
          </Card>
        ) : error ? (
          <Card className="py-4">
            <EmptyState
              icon={<BarChart3 className="h-6 w-6" aria-hidden />}
              title="Статистика временно недоступна"
              body="Публикации не пропали. Проверь соединение и повтори загрузку."
              action={(
                <Button variant="secondary" onClick={() => void load()}>
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Повторить загрузку
                </Button>
              )}
            />
          </Card>
        ) : data ? (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] font-semibold text-text">
                {data.sourceLabel} · {data.periodLabel.toLocaleLowerCase("ru-RU")} · {activeTopic}
              </p>
              {windowLabel && <span className="text-[11px] text-text-3">{windowLabel}</span>}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <Metric
                featured
                label="Публикации"
                value={fmtCompact(data.summary.posts)}
                detail="Вышли за выбранный период"
                change={(
                  <Change
                    value={data.summary.postsChange}
                    current={data.summary.posts}
                    previous={data.comparison.previousPosts}
                  />
                )}
              />
              <Metric label="Источники" value={fmtCompact(data.summary.sources)} detail="Каналы с публикациями" />
              <Metric featured label="Просмотры" value={fmtCompact(data.summary.views)} detail="Текущий накопленный счётчик" />
              <Metric label="В среднем" value={fmtCompact(data.summary.avgViews)} detail="Просмотров на публикацию" />
              <Metric label={trendMetricLabel} value={fmtCompact(data.summary.trends)} detail={trendMetricDetail} />
              <Metric
                label="Доля реакций"
                value={`${data.summary.engagementRate.toLocaleString("ru-RU")}%`}
                detail="Реакции относительно просмотров"
              />
            </div>

            <div className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-text-3">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <p>
                Просмотры — текущий накопленный счётчик у публикаций, а не прирост просмотров внутри периода. Поэтому сравнение с прошлым периодом показываем только для количества публикаций.
              </p>
            </div>

            {data.summary.posts === 0 ? (
              <Card className="mt-5 py-4">
                <EmptyState
                  icon={<Search className="h-6 w-6" aria-hidden />}
                  title={topic ? `По теме «${topic}» данных пока нет` : "За этот период публикаций нет"}
                  body={source === "internet"
                    ? "Измени тему или период. Чтобы добавить свежие данные, запусти новый проверенный поиск в интернет-ленте."
                    : topic
                      ? "Попробуй более широкую формулировку, другой период или другую базу."
                      : "Выбери более длинный период или другую базу."}
                  action={topic ? (
                    <Button variant="secondary" onClick={clearTopic}>Показать все темы</Button>
                  ) : source === "internet" && onOpenFeed ? (
                    <Button variant="primary" onClick={() => onOpenFeed("internet")}>Найти публикации</Button>
                  ) : undefined}
                />
              </Card>
            ) : (
              <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
                <ActivityChart data={data} />
                <Card className="p-4 sm:p-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <div>
                      <h3 className="text-[15px] font-bold text-text">Лидеры выборки</h3>
                      <p className="mt-1 text-[12px] text-text-3">
                        {source === "internet"
                          ? "Сначала трендовые сигналы, затем качество и просмотры."
                          : "Сначала публикации выше обычной нормы своего канала."}
                      </p>
                    </div>
                    {maxViews > 0 && <span className="shrink-0 text-[11px] text-text-3">до {fmtCompact(maxViews)}</span>}
                  </div>
                  <ol className="mt-4 space-y-3">
                    {data.topItems.map((item, index) => (
                      <li key={`${item.url}:${item.id}:${index}`} className="rounded-md bg-surface-inset p-3">
                        <div className="flex items-start gap-3">
                          <span className="nums flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-bold text-text-2">
                            {index + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-[12px] font-bold text-text">{item.sourceTitle || "Telegram"}</span>
                              {item.ratio != null && <Badge tone="fire">×{item.ratio.toLocaleString("ru-RU")} к норме</Badge>}
                              {item.qualityScore != null && <Badge tone="brand">качество {item.qualityScore}/100</Badge>}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-3">
                              <span>{fmtCompact(item.views)} просмотров</span>
                              {item.reactions > 0 && <span>{fmtCompact(item.reactions)} {plural(item.reactions, "реакция", "реакции", "реакций")}</span>}
                              {item.postedAt && <span>{fmtAgo(item.postedAt)}</span>}
                            </div>
                            <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-text-2">
                              {item.text?.trim() || item.reason || "Публикация без текста"}
                            </p>
                            {item.url && (
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-2 inline-flex min-h-8 items-center gap-1 text-[12px] font-semibold text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                              >
                                Открыть публикацию
                                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                              </a>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                </Card>
              </div>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}
