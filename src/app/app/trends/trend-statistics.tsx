"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Database,
  ExternalLink,
  Globe2,
  LibraryBig,
  RefreshCw,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, EmptyState, Input } from "@/components/ui/primitives";
import {
  TREND_STAT_PERIODS,
  TREND_STAT_SOURCES,
  type TrendStatPeriod,
  type TrendStatSource,
} from "@/lib/trend-statistics";
import { cn, fmtAgo, fmtCompact } from "@/lib/utils";

type TrendStatsData = {
  source: TrendStatSource;
  sourceLabel: string;
  sourceDescription: string;
  period: TrendStatPeriod;
  periodLabel: string;
  topic: string;
  channelId: number | null;
  window: { from: string | null; to: string | null };
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

const SOURCE_ICONS = {
  own: Database,
  internet: Globe2,
  collection: LibraryBig,
} satisfies Record<TrendStatSource, typeof Database>;

function Change({ value, label }: { value: number | null; label: string }) {
  if (value == null) return <span className="text-[11px] text-text-3">нет периода для сравнения</span>;
  const positive = value >= 0;
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn(
      "inline-flex items-center gap-1 text-[11px] font-semibold",
      positive ? "text-success-text" : "text-danger-text",
    )}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {positive ? "+" : ""}{value.toLocaleString("ru-RU")}% {label}
    </span>
  );
}

function Metric({ label, value, change }: { label: string; value: string; change?: React.ReactNode }) {
  return (
    <Card className="min-w-0 p-4">
      <p className="text-[12px] font-semibold text-text-3">{label}</p>
      <p className="mt-1 nums truncate text-[24px] leading-tight font-bold text-text">{value}</p>
      {change && <div className="mt-2">{change}</div>}
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

function ActivityChart({ data }: { data: TrendStatsData }) {
  const max = Math.max(1, ...data.series.map((point) => point.posts));
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-[15px] font-bold text-text">Динамика публикаций</h3>
          <p className="mt-1 text-[12px] text-text-3">Количество найденных публикаций по времени.</p>
        </div>
        <span className="text-[12px] text-text-3">{data.periodLabel.toLocaleLowerCase("ru-RU")}</span>
      </div>

      <div className="mt-5 flex h-36 items-end gap-1" aria-hidden="true">
        {data.series.map((point) => (
          <div
            key={point.bucket}
            className="group relative flex h-full min-w-0 flex-1 items-end"
            title={`${formatBucket(point.bucket, data.period)}: ${point.posts} публикаций, ${point.views} просмотров`}
          >
            <div
              className={cn(
                "w-full rounded-t-[4px] bg-brand/25 transition-colors group-hover:bg-brand/55",
                point.posts === 0 && "bg-surface-inset",
              )}
              style={{ height: `${point.posts === 0 ? 3 : Math.max(8, (point.posts / max) * 100)}%` }}
            />
          </div>
        ))}
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

export function TrendStatistics({
  channelId,
  channelTopic,
}: {
  channelId: number | null;
  channelTopic?: string | null;
}) {
  const [source, setSource] = useState<TrendStatSource>("own");
  const [period, setPeriod] = useState<TrendStatPeriod>("week");
  const [topicInput, setTopicInput] = useState("");
  const [topic, setTopic] = useState("");
  const [data, setData] = useState<TrendStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (source !== "collection" && !channelId) {
      setData(null);
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
    setTopic(topicInput.trim());
  };

  return (
    <section aria-labelledby="trend-statistics-title" className="mt-7">
      <div className="max-w-3xl">
        <h2 id="trend-statistics-title" className="flex items-center gap-2 text-[19px] font-bold text-text">
          <BarChart3 className="h-5 w-5 text-brand" aria-hidden />
          Статистика трендов
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-text-3">
          Сравнивай активность, просмотры и публикации по периоду, тематике и источнику данных.
        </p>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.7fr)]">
        <fieldset>
          <legend className="mb-2 text-[12px] font-semibold text-text-3">Источник данных</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(Object.keys(TREND_STAT_SOURCES) as TrendStatSource[]).map((value) => {
              const item = TREND_STAT_SOURCES[value];
              const Icon = SOURCE_ICONS[value];
              const active = source === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSource(value)}
                  className={cn(
                    "min-h-20 rounded-md border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2",
                    active
                      ? "border-brand bg-brand-soft text-text"
                      : "border-line bg-surface text-text-2 hover:border-line-strong",
                  )}
                >
                  <span className="flex items-center gap-2 text-[13px] font-bold">
                    <Icon className="h-4 w-4" aria-hidden />
                    {item.label}
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-text-3">{item.description}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-[12px] font-semibold text-text-3">Период</legend>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(TREND_STAT_PERIODS) as TrendStatPeriod[]).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={period === value}
                onClick={() => setPeriod(value)}
                className={cn(
                  "min-h-11 rounded-sm border px-3.5 py-2 text-[13px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2",
                  period === value
                    ? "border-brand bg-brand-soft text-text"
                    : "border-line bg-surface text-text-2 hover:border-line-strong",
                )}
              >
                {TREND_STAT_PERIODS[value].label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <form onSubmit={applyTopic} className="mt-5 flex max-w-3xl flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="trend-stat-topic" className="mb-2 block text-[12px] font-semibold text-text-3">
            Тематика
          </label>
          <Input
            id="trend-stat-topic"
            value={topicInput}
            onChange={(event) => setTopicInput(event.target.value)}
            placeholder="Например: рыбалка, садоводство или банкротство"
          />
        </div>
        <Button type="submit" variant="solid">
          <Search className="h-4 w-4" aria-hidden />
          Применить тему
        </Button>
        {topic && (
          <Button
            type="button"
            variant="soft"
            onClick={() => {
              setTopicInput("");
              setTopic("");
            }}
          >
            Все темы
          </Button>
        )}
      </form>
      {channelTopic && channelTopic.trim() && topic !== channelTopic.trim() && (
        <button
          type="button"
          onClick={() => {
            setTopicInput(channelTopic.trim());
            setTopic(channelTopic.trim());
          }}
          className="mt-2 min-h-8 text-[12px] font-semibold text-brand underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Использовать тематику канала: {channelTopic.trim()}
        </button>
      )}

      <div className="mt-6" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {Array.from({ length: 6 }, (_, index) => <div key={index} className="skeleton h-24 rounded-md" />)}
          </div>
        ) : error ? (
          <Card className="py-4">
            <EmptyState
              icon={<BarChart3 className="h-6 w-6" aria-hidden />}
              title="Статистика временно недоступна"
              body="Публикации не пропали. Проверь соединение и повтори загрузку."
              action={(
                <Button variant="soft" onClick={() => void load()}>
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Повторить загрузку
                </Button>
              )}
            />
          </Card>
        ) : !channelId && source !== "collection" ? (
          <Card className="py-4">
            <EmptyState
              icon={<Database className="h-6 w-6" aria-hidden />}
              title="Выбери канал"
              body="Канал нужен, чтобы показать только твоих конкурентов и результаты твоих поисков."
            />
          </Card>
        ) : data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <Metric
                label="Публикации"
                value={fmtCompact(data.summary.posts)}
                change={<Change value={data.summary.postsChange} label="к прошлому периоду" />}
              />
              <Metric label="Источники" value={fmtCompact(data.summary.sources)} />
              <Metric
                label="Просмотры"
                value={fmtCompact(data.summary.views)}
                change={<Change value={data.summary.viewsChange} label="к прошлому периоду" />}
              />
              <Metric label="Средние просмотры" value={fmtCompact(data.summary.avgViews)} />
              <Metric label="Набирают интерес" value={fmtCompact(data.summary.trends)} />
              <Metric label="Реакции / просмотры" value={`${data.summary.engagementRate.toLocaleString("ru-RU")}%`} />
            </div>

            {data.summary.posts === 0 ? (
              <Card className="mt-5 py-4">
                <EmptyState
                  icon={<Search className="h-6 w-6" aria-hidden />}
                  title={topic ? `По теме «${topic}» данных пока нет` : "За этот период публикаций нет"}
                  body={topic
                    ? "Попробуй более широкую формулировку, другой период или другой источник данных."
                    : "Выбери более длинный период или другой источник данных."}
                  action={topic ? (
                    <Button
                      variant="soft"
                      onClick={() => {
                        setTopicInput("");
                        setTopic("");
                      }}
                    >
                      Показать все темы
                    </Button>
                  ) : undefined}
                />
              </Card>
            ) : (
              <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
                <ActivityChart data={data} />
                <Card className="p-4 sm:p-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <div>
                      <h3 className="text-[15px] font-bold text-text">Что набирает интерес</h3>
                      <p className="mt-1 text-[12px] text-text-3">Лучшие публикации выбранной базы.</p>
                    </div>
                    {maxViews > 0 && <span className="text-[11px] text-text-3">до {fmtCompact(maxViews)} просмотров</span>}
                  </div>
                  <ol className="mt-4 space-y-3">
                    {data.topItems.map((item) => (
                      <li key={`${item.url}:${item.id}`} className="rounded-md bg-surface-inset p-3">
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-3">
                          <span className="font-semibold text-text-2">{item.sourceTitle || "Telegram"}</span>
                          <span>{fmtCompact(item.views)} просмотров</span>
                          {item.ratio != null && <span>×{item.ratio.toLocaleString("ru-RU")} к норме</span>}
                          {item.qualityScore != null && <span>{item.qualityScore}/100</span>}
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
                      </li>
                    ))}
                  </ol>
                </Card>
              </div>
            )}

            <p className="mt-3 text-[11px] leading-relaxed text-text-3">
              {data.sourceDescription} Интернет-статистика охватывает только ссылки, которые Аврора уже нашла и проверила; это не полный индекс Telegram.
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}
