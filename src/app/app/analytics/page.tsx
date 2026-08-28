"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Eye,
  FileText,
  Gauge,
  Heart,
  Info,
  MousePointerClick,
  RefreshCw,
  Send,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Trophy,
  UserRoundSearch,
  Users,
} from "lucide-react";

import { ChannelPicker, useChannelChoice } from "@/components/app/channel-picker";
import { AppShell } from "@/components/app/shell";
import { ProjectExportButton } from "@/components/app/project-export-button";
import { TrackingAnalyticsSection } from "@/components/app/tracking-analytics";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import type { AnalyticsPeriodDays } from "@/lib/analytics-dashboard";
import { useStore } from "@/lib/store";
import { cn, fmtNum } from "@/lib/utils";

type AnalyticsSection = "overview" | "posts" | "growth" | "competitors" | "tracking";
type PostMetric = "views" | "reactions" | "engagement";

function safeChannelId(value: string | null): number | null {
  const channelId = Number(value);
  return Number.isSafeInteger(channelId) && channelId > 0 ? channelId : null;
}

interface SubscriberPoint {
  snapshot_date: string;
  subscribers: number;
}

interface PostStat {
  id: number;
  text: string;
  published_at: string;
  stats_state: string | null;
  views: number | null;
  reactions: number | null;
  engagementRate: number | null;
  monthly_campaign_id: number | null;
  monthly_campaign_goal: string | null;
  monthly_item_id: number | null;
  monthly_item_title: string | null;
}

interface CompetitorStat {
  id: number;
  label: string;
  network: string;
  handle: string;
  subscribers: number | null;
  subscriberGrowth: number | null;
  posts: number;
  postsWithMetrics: number;
  medianViews: number | null;
  averageInteractions: number | null;
  confidence: "insufficient" | "low" | "medium" | "high";
  status: string;
  collectedAt: string | null;
}

interface StatsData {
  hasChannel: boolean;
  channelTitle?: string | null;
  latestSubs?: number | null;
  subscriberGrowth?: number | null;
  subscriberSeries?: SubscriberPoint[];
  posts?: PostStat[];
  competitors?: CompetitorStat[];
  totals?: {
    published: number;
    withMetrics: number;
    missing: number;
    unverified: number;
    totalViews: number;
    avgViews: number | null;
    medianViews: number | null;
    totalReactions: number;
    engagementRate: number | null;
  };
  comparisons?: {
    averageViewsPercent: number | null;
    engagementPoints: number | null;
    publishedPercent: number | null;
  };
  cohort?: {
    label: string;
    verifiedPosts: number;
    withMetrics: number;
    missing: number;
    unverified: number;
    averageFormula: string | null;
    confidence: "insufficient" | "low" | "medium" | "high";
  };
  period?: { days: number; timeZone: string; label: string };
  bestPost?: { id: number; text: string; views: number; reactions: number | null } | null;
  insight?: string | null;
  available?: { views: boolean; reactions: boolean; subscribers: boolean; reach: boolean; comments: boolean };
  collectedAt?: string | null;
}

const SECTIONS: Array<{ id: AnalyticsSection; label: string; icon: typeof Activity }> = [
  { id: "overview", label: "Обзор", icon: Activity },
  { id: "posts", label: "Публикации", icon: FileText },
  { id: "growth", label: "Рост", icon: TrendingUp },
  { id: "competitors", label: "Конкуренты", icon: UserRoundSearch },
  { id: "tracking", label: "Переходы", icon: MousePointerClick },
];

const CONFIDENCE_LABELS = {
  insufficient: "данных недостаточно",
  low: "низкая",
  medium: "средняя",
  high: "высокая",
} as const;

function shortTitle(text: string, limit = 72): string {
  const title = text.split(/\n/u).map((part) => part.trim()).find(Boolean) || "Публикация";
  return title.length > limit ? `${title.slice(0, limit - 1)}…` : title;
}

function formatDay(value: string): string {
  return new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
  });
}

function formatPublishedAt(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: timezone,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleDateString("ru-RU");
  }
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toLocaleString("ru-RU")}`;
}

function comparisonText(value: number | null, unit = "%"): string {
  if (value == null) return "Нет сопоставимого прошлого периода";
  if (value === 0) return "Без изменений к прошлому периоду";
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toLocaleString("ru-RU")}${unit} к прошлому периоду`;
}

function selectClassName(): string {
  return "min-h-11 w-full rounded-xs border border-line bg-surface px-3 text-base text-text focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[14px]";
}

function MetricCard({ icon, label, value, note, tone }: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  note: React.ReactNode;
  tone?: "up" | "down";
}) {
  return (
    <Card className="min-w-0 p-4">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-text-3">{icon}<span>{label}</span></div>
      <p className="nums mt-2 text-[26px] leading-none font-extrabold tabular-nums text-text">{value}</p>
      <p className={cn(
        "mt-2 text-pretty text-[12px] leading-relaxed font-semibold",
        tone === "up" ? "text-success-text" : tone === "down" ? "text-danger-text" : "text-text-3",
      )}>{note}</p>
    </Card>
  );
}

function ChartEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid min-h-52 place-items-center rounded-sm bg-surface-inset px-5 py-8 text-center">
      <div>
        <BarChart3 className="mx-auto h-6 w-6 text-text-3" aria-hidden />
        <p className="mt-3 font-semibold text-text">{title}</p>
        <p className="mx-auto mt-1 max-w-[48ch] text-pretty text-[13px] leading-relaxed text-text-3">{body}</p>
      </div>
    </div>
  );
}

function SubscriberLineChart({ series, compact = false }: { series: SubscriberPoint[]; compact?: boolean }) {
  if (series.length === 0) {
    return <ChartEmpty title="Снимков подписчиков пока нет" body="После первого успешного сбора появится реальная линия аудитории." />;
  }
  if (series.length === 1) {
    return (
      <div className="grid min-h-52 place-items-center rounded-sm bg-surface-inset p-6 text-center">
        <div>
          <p className="nums text-[38px] leading-none font-extrabold text-text">{fmtNum(series[0].subscribers)}</p>
          <p className="mt-2 text-[13px] text-text-3">Первая точка от {formatDay(series[0].snapshot_date)}. Для линии нужен ещё один ежедневный снимок.</p>
        </div>
      </div>
    );
  }

  const width = 760;
  const height = compact ? 170 : 250;
  const padX = 24;
  const padY = 20;
  const values = series.map((point) => point.subscribers);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index: number) => padX + (index / (series.length - 1)) * (width - padX * 2);
  const y = (value: number) => height - padY - ((value - min) / span) * (height - padY * 2);
  const points = series.map((point, index) => `${x(index)},${y(point.subscribers)}`).join(" ");
  const area = `${padX},${height - padY} ${points} ${width - padX},${height - padY}`;
  const description = `Подписчики изменились с ${values[0].toLocaleString("ru-RU")} до ${values.at(-1)?.toLocaleString("ru-RU")} за ${series.length} точек.`;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className={compact ? "h-44 w-full" : "h-64 w-full"} role="img" aria-label={description} preserveAspectRatio="none">
        <defs>
          <linearGradient id={compact ? "subscriber-fill-compact" : "subscriber-fill"} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--brand-1)" stopOpacity="0.3" />
            <stop offset="1" stopColor="var(--brand-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line key={ratio} x1={padX} x2={width - padX} y1={padY + ratio * (height - padY * 2)} y2={padY + ratio * (height - padY * 2)} stroke="var(--line)" strokeDasharray="5 7" vectorEffect="non-scaling-stroke" />
        ))}
        <polygon points={area} fill={`url(#${compact ? "subscriber-fill-compact" : "subscriber-fill"})`} />
        <polyline points={points} fill="none" stroke="var(--brand-1)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {series.map((point, index) => (
          <circle key={`${point.snapshot_date}:${point.subscribers}`} cx={x(index)} cy={y(point.subscribers)} r={index === 0 || index === series.length - 1 ? 4 : 2.5} fill="var(--surface)" stroke="var(--brand-1)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="mt-1 flex items-center justify-between gap-4 text-[12px] text-text-3">
        <span>{formatDay(series[0].snapshot_date)} · {fmtNum(series[0].subscribers)}</span>
        <span>{formatDay(series.at(-1)?.snapshot_date ?? "")} · {fmtNum(series.at(-1)?.subscribers ?? 0)}</span>
      </div>
    </div>
  );
}

function DailyGrowthChart({ series }: { series: SubscriberPoint[] }) {
  const deltas = series.slice(1).map((point, index) => ({
    date: point.snapshot_date,
    value: point.subscribers - series[index].subscribers,
  }));
  if (deltas.length === 0) {
    return <ChartEmpty title="Дневная динамика ещё не сформирована" body="Для прироста нужны как минимум два последовательных снимка аудитории." />;
  }
  const width = 760;
  const height = 190;
  const padX = 18;
  const mid = height / 2;
  const maxAbs = Math.max(...deltas.map((point) => Math.abs(point.value)), 1);
  const gap = 4;
  const barWidth = Math.max(4, (width - padX * 2) / deltas.length - gap);
  const scale = (height / 2 - 24) / maxAbs;
  const visibleLabels = deltas.length <= 14;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-52 w-full" role="img" aria-label={`Дневное изменение подписчиков по ${deltas.length} интервалам`} preserveAspectRatio="none">
        <line x1={padX} x2={width - padX} y1={mid} y2={mid} stroke="var(--line-strong)" vectorEffect="non-scaling-stroke" />
        {deltas.map((point, index) => {
          const barHeight = Math.max(2, Math.abs(point.value) * scale);
          const x = padX + index * ((width - padX * 2) / deltas.length) + gap / 2;
          const y = point.value >= 0 ? mid - barHeight : mid;
          return <rect key={point.date} x={x} y={y} width={barWidth} height={barHeight} rx="2" fill={point.value >= 0 ? "var(--success)" : "var(--danger)"} opacity="0.86" />;
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-[12px] text-text-3">
        {visibleLabels ? deltas.map((point) => <span key={point.date}>{formatDay(point.date)}: <b className="font-semibold text-text">{signed(point.value)}</b></span>) : <span>Точные значения доступны в ежедневных точках линии выше.</span>}
      </div>
    </div>
  );
}

function metricValue(post: PostStat, metric: PostMetric): number | null {
  if (metric === "views") return post.views;
  if (metric === "reactions") return post.reactions;
  return post.engagementRate;
}

function PostPerformanceChart({ posts, metric, onMetricChange }: {
  posts: PostStat[];
  metric: PostMetric;
  onMetricChange: (metric: PostMetric) => void;
}) {
  const measured = posts.filter((post) => metricValue(post, metric) != null).slice(0, 12).reverse();
  const max = Math.max(...measured.map((post) => metricValue(post, metric) ?? 0), 1);
  const labels: Record<PostMetric, string> = { views: "Просмотры", reactions: "Реакции", engagement: "Доля реакций" };

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-[17px] font-bold text-text">Результат каждой публикации</h2>
          <p className="mt-1 max-w-[58ch] text-[13px] leading-relaxed text-text-3">Столбцы построены по последнему полученному снимку. Точные значения и дата остаются рядом.</p>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Показатель графика публикаций">
          {(Object.keys(labels) as PostMetric[]).map((option) => (
            <button key={option} type="button" aria-pressed={metric === option} onClick={() => onMetricChange(option)} className={cn(
              "min-h-11 rounded-xs px-3 text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
              metric === option ? "bg-info-soft text-info-text ring-1 ring-brand/30 ring-inset" : "bg-surface-inset text-text-2 hover:text-text",
            )}>{labels[option]}</button>
          ))}
        </div>
      </div>
      <div className="mt-6">
        {measured.length === 0 ? (
          <ChartEmpty title={`Нет данных: ${labels[metric].toLocaleLowerCase("ru-RU")}`} body="Выберите другой показатель или обновите статистику после получения данных сети." />
        ) : (
          <ol className="space-y-4" aria-label={`Сравнение публикаций: ${labels[metric]}`}>
            {measured.map((post) => {
              const value = metricValue(post, metric) ?? 0;
              return (
                <li key={post.id} className="grid min-w-0 gap-2 md:grid-cols-[minmax(12rem,0.8fr)_minmax(14rem,1.2fr)_auto] md:items-center">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-text">{shortTitle(post.text, 54)}</p>
                    <p className="mt-0.5 text-[11px] text-text-3">{new Date(post.published_at).toLocaleDateString("ru-RU")}</p>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-surface-inset" aria-hidden>
                    <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(3, (value / max) * 100)}%` }} />
                  </div>
                  <p className="nums min-w-20 text-right text-[13px] font-bold tabular-nums text-text">{metric === "engagement" ? `${value.toLocaleString("ru-RU")}%` : fmtNum(value)}</p>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Card>
  );
}

function CompetitorBenchmarkChart({ ownLabel, ownMedian, ownPosts, competitors }: {
  ownLabel: string;
  ownMedian: number | null;
  ownPosts: number;
  competitors: CompetitorStat[];
}) {
  const entries = [
    { id: "own", label: ownLabel, medianViews: ownMedian, posts: ownPosts, own: true, confidence: "high" },
    ...competitors.map((competitor) => ({ ...competitor, own: false })),
  ].filter((entry) => entry.medianViews != null).sort((a, b) => Number(b.medianViews) - Number(a.medianViews));
  const max = Math.max(...entries.map((entry) => Number(entry.medianViews ?? 0)), 1);
  if (entries.length === 0) {
    return <ChartEmpty title="Пока нечего сравнивать" body="Нужны просмотры собственных публикаций или открытые показатели хотя бы одного конкурента." />;
  }
  return (
    <ol className="space-y-5" aria-label="Сравнение медианных просмотров каналов">
      {entries.map((entry) => (
        <li key={entry.id}>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <p className="text-[13px] font-semibold text-text">{entry.label} {entry.own ? <Badge tone="brand" className="ml-1">ваш канал</Badge> : null}</p>
            <p className="nums text-[13px] font-bold tabular-nums text-text">{fmtNum(Number(entry.medianViews))} <span className="font-medium text-text-3">медиана · {entry.posts} пост.</span></p>
          </div>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-surface-inset" aria-hidden>
            <div className={cn("h-full rounded-full", entry.own ? "bg-brand" : "bg-fire")} style={{ width: `${Math.max(3, (Number(entry.medianViews) / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function OverviewSection({ data, onOpen }: { data: StatsData; onOpen: (section: AnalyticsSection) => void }) {
  const growth = data.subscriberGrowth ?? null;
  const averageComparison = data.comparisons?.averageViewsPercent ?? null;
  const engagementComparison = data.comparisons?.engagementPoints ?? null;
  return (
    <div className="space-y-5">
      <Card className="overflow-hidden p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-gradient text-white shadow-glow"><Sparkles className="h-5 w-5" aria-hidden /></span>
            <div className="min-w-0">
              <p className="type-caption font-bold tracking-wide text-text-3 uppercase">Главный вывод периода</p>
              <p className="mt-2 max-w-[68ch] text-pretty text-[17px] leading-relaxed font-medium text-text">{data.insight ?? "Данных пока недостаточно для честного вывода. Аврора покажет изменение после появления сопоставимого прошлого периода."}</p>
              <p className="mt-2 text-[12px] font-semibold text-text-3">Выборка: {data.cohort?.withMetrics ?? 0} · уверенность: {CONFIDENCE_LABELS[data.cohort?.confidence ?? "insufficient"]}</p>
            </div>
          </div>
          <Button variant="secondary" size="sm" className="shrink-0" onClick={() => onOpen("posts")}>Разобрать публикации <ArrowRight className="h-4 w-4" aria-hidden /></Button>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard icon={<Users className="h-4 w-4" aria-hidden />} label="Подписчики" value={data.latestSubs == null ? "—" : fmtNum(data.latestSubs)} note={growth == null ? "Нужны минимум две точки" : `${signed(growth)} за период`} tone={growth == null || growth === 0 ? undefined : growth > 0 ? "up" : "down"} />
        <MetricCard icon={<Eye className="h-4 w-4" aria-hidden />} label="Просмотров на пост" value={data.totals?.avgViews == null ? "—" : fmtNum(data.totals.avgViews)} note={comparisonText(averageComparison)} tone={averageComparison == null || averageComparison === 0 ? undefined : averageComparison > 0 ? "up" : "down"} />
        <MetricCard icon={<Heart className="h-4 w-4" aria-hidden />} label="Доля реакций" value={data.totals?.engagementRate == null ? "—" : `${data.totals.engagementRate.toLocaleString("ru-RU")}%`} note={comparisonText(engagementComparison, " п. п.")} tone={engagementComparison == null || engagementComparison === 0 ? undefined : engagementComparison > 0 ? "up" : "down"} />
        <MetricCard icon={<FileText className="h-4 w-4" aria-hidden />} label="Подтверждённые посты" value={fmtNum(data.totals?.published ?? 0)} note={`${data.totals?.withMetrics ?? 0} со статистикой`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(18rem,0.7fr)]">
        <Card className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-[17px] font-bold text-text">Динамика аудитории</h2><p className="mt-1 text-[13px] text-text-3">Реальные ежедневные снимки выбранного канала.</p></div><Button variant="ghost" size="sm" onClick={() => onOpen("growth")}>Подробнее <ArrowRight className="h-4 w-4" aria-hidden /></Button></div>
          <div className="mt-4"><SubscriberLineChart series={data.subscriberSeries ?? []} compact /></div>
        </Card>
        <Card className="p-5 sm:p-6">
          <Trophy className="h-6 w-6 text-fire-text" aria-hidden />
          <h2 className="mt-4 text-[17px] font-bold text-text">Лучший результат</h2>
          {data.bestPost ? <><p className="mt-3 text-pretty text-[14px] leading-relaxed font-semibold text-text">{shortTitle(data.bestPost.text)}</p><p className="nums mt-3 text-[24px] font-extrabold tabular-nums text-text">{fmtNum(data.bestPost.views)} <span className="text-[13px] font-semibold text-text-3">просмотров</span></p>{data.bestPost.reactions != null ? <p className="mt-1 text-[13px] text-text-3">{fmtNum(data.bestPost.reactions)} реакций</p> : null}</> : <p className="mt-3 text-[14px] leading-relaxed text-text-3">Лучший пост появится после получения просмотров минимум одной подтверждённой публикации.</p>}
        </Card>
      </div>
    </div>
  );
}

function PostsSection({ data, metric, onMetricChange }: { data: StatsData; metric: PostMetric; onMetricChange: (metric: PostMetric) => void }) {
  const posts = data.posts ?? [];
  const timezone = data.period?.timeZone ?? "Europe/Moscow";
  const bestViews = Math.max(...posts.map((post) => post.views ?? 0), 0);
  return (
    <div className="space-y-5">
      <div><h2 className="text-balance text-[20px] font-bold text-text">Статистика публикаций</h2><p className="mt-1 max-w-[68ch] text-pretty text-[14px] leading-relaxed text-text-3">Какие материалы получили больше просмотров и реакций в выбранном периоде.</p></div>
      <PostPerformanceChart posts={posts} metric={metric} onMetricChange={onMetricChange} />
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-[17px] font-bold text-text">Подтверждённые публикации</h2><Badge tone="neutral">Данные: {data.totals?.withMetrics ?? 0} из {data.totals?.published ?? 0}</Badge></div>
        {posts.length === 0 ? <div className="mt-4"><ChartEmpty title="Публикаций в периоде нет" body="Выберите более длинный период или опубликуйте первый материал." /></div> : (
          <ol className="mt-5 divide-y divide-line">
            {posts.map((post) => (
              <li key={post.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0"><p className="text-pretty text-[14px] leading-relaxed font-semibold text-text">{shortTitle(post.text, 110)}</p><p className="mt-1 text-[12px] text-text-3">{formatPublishedAt(post.published_at, timezone)}</p></div>
                  <div className="flex shrink-0 flex-wrap gap-2 text-[12px] font-semibold"><Badge tone="neutral"><Eye className="h-3.5 w-3.5" aria-hidden />{post.views == null ? "ещё нет" : fmtNum(post.views)}</Badge><Badge tone="neutral"><Heart className="h-3.5 w-3.5" aria-hidden />{post.reactions == null ? "недоступно" : fmtNum(post.reactions)}</Badge>{post.views != null && post.views === bestViews && bestViews > 0 ? <Badge tone="fire">лучший</Badge> : null}</div>
                </div>
                {post.views == null ? <p className="mt-2 text-[12px] leading-relaxed text-text-3">{post.stats_state === "gone" ? "Публикация удалена из канала." : post.stats_state === "private" ? "У канала нет публичного адреса — просмотры недоступны." : "Цифры ещё не собраны — обычно они появляются после следующего обхода."}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function GrowthSection({ data }: { data: StatsData }) {
  const series = data.subscriberSeries ?? [];
  const first = series[0]?.subscribers ?? null;
  const latest = series.at(-1)?.subscribers ?? null;
  const growth = data.subscriberGrowth ?? null;
  return (
    <div className="space-y-5">
      <div><h2 className="text-balance text-[20px] font-bold text-text">Рост аудитории</h2><p className="mt-1 max-w-[68ch] text-pretty text-[14px] leading-relaxed text-text-3">Общий размер канала и дневные изменения по фактическим снимкам подписчиков.</p></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard icon={<Users className="h-4 w-4" aria-hidden />} label="В начале периода" value={first == null ? "—" : fmtNum(first)} note={series[0] ? formatDay(series[0].snapshot_date) : "Нет первой точки"} />
        <MetricCard icon={<Users className="h-4 w-4" aria-hidden />} label="Сейчас" value={latest == null ? "—" : fmtNum(latest)} note={series.at(-1) ? formatDay(series.at(-1)?.snapshot_date ?? "") : "Нет последней точки"} />
        <MetricCard icon={growth != null && growth < 0 ? <TrendingDown className="h-4 w-4" aria-hidden /> : <TrendingUp className="h-4 w-4" aria-hidden />} label="Изменение" value={growth == null ? "—" : signed(growth)} note={growth == null ? "Нужны минимум две точки" : data.period?.label ?? "Выбранный период"} tone={growth == null || growth === 0 ? undefined : growth > 0 ? "up" : "down"} />
        <MetricCard icon={<Gauge className="h-4 w-4" aria-hidden />} label="Дней со снимками" value={fmtNum(series.length)} note={`из ${data.period?.days ?? 0} дней периода`} />
      </div>
      <Card className="p-5 sm:p-6"><h2 className="text-[17px] font-bold text-text">Размер аудитории</h2><p className="mt-1 text-[13px] text-text-3">Линия не интерполирует отсутствующие дни: каждая точка получена при сборе.</p><div className="mt-5"><SubscriberLineChart series={series} /></div></Card>
      <Card className="p-5 sm:p-6"><h2 className="text-[17px] font-bold text-text">Изменение между снимками</h2><p className="mt-1 text-[13px] text-text-3">Зелёный столбец — прирост, красный — снижение.</p><div className="mt-5"><DailyGrowthChart series={series} /></div></Card>
    </div>
  );
}

function CompetitorsSection({ data, channelId }: { data: StatsData; channelId: number | null }) {
  const competitors = data.competitors ?? [];
  const comparable = competitors.filter((competitor) => competitor.medianViews != null);
  const bestCompetitor = [...comparable].sort((a, b) => Number(b.medianViews) - Number(a.medianViews))[0];
  const ownMedian = data.totals?.medianViews ?? null;
  const comparison = bestCompetitor && ownMedian != null
    ? ownMedian >= Number(bestCompetitor.medianViews)
      ? `Медиана вашего канала выше лучшего доступного ориентира на ${(ownMedian - Number(bestCompetitor.medianViews)).toLocaleString("ru-RU")} просмотров.`
      : `До медианы лидера «${bestCompetitor.label}» — ${(Number(bestCompetitor.medianViews) - ownMedian).toLocaleString("ru-RU")} просмотров.`
    : null;
  return (
    <div className="space-y-5">
      <div><h2 className="text-balance text-[20px] font-bold text-text">Сравнение с конкурентами</h2><p className="mt-1 max-w-[70ch] text-pretty text-[14px] leading-relaxed text-text-3">Публичные просмотры и частота публикаций. Каналы разного размера сравниваются по медиане, а не по одному случайному хиту.</p></div>
      {competitors.length === 0 ? (
        <Card><EmptyState icon={<UserRoundSearch className="h-6 w-6" aria-hidden />} title="Конкуренты ещё не добавлены" body="Добавьте публичные каналы из той же ниши — после сбора здесь появится честное сравнение." action={<Link className={buttonClassName({ variant: "primary", size: "sm" })} href={`/app/competitors${channelId ? `?channel=${channelId}` : ""}`}>Добавить конкурентов</Link>} /></Card>
      ) : (
        <>
          <Card className="p-5 sm:p-6"><div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div><h2 className="text-[17px] font-bold text-text">Медианные просмотры</h2><p className="mt-1 max-w-[60ch] text-[13px] leading-relaxed text-text-3">Половина публикаций канала получила больше этого значения, половина — меньше.</p></div><Badge tone="neutral">{comparable.length} с данными</Badge></div>{comparison ? <p className="mt-4 rounded-sm bg-info-soft px-4 py-3 text-[13px] font-semibold text-info-text">{comparison}</p> : null}<div className="mt-6"><CompetitorBenchmarkChart ownLabel={data.channelTitle || "Ваш канал"} ownMedian={ownMedian} ownPosts={data.totals?.published ?? 0} competitors={competitors} /></div></Card>
          <div className="grid gap-3 md:grid-cols-2">
            {competitors.map((competitor) => (
              <Card key={competitor.id} className="p-5">
                <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-[15px] font-bold text-text">{competitor.label}</h3><p className="mt-1 text-[12px] text-text-3">@{competitor.handle} · {competitor.posts} публикаций</p></div><Badge tone={competitor.confidence === "insufficient" ? "fire" : "neutral"}>{CONFIDENCE_LABELS[competitor.confidence]}</Badge></div>
                <dl className="mt-4 grid grid-cols-2 gap-3"><div><dt className="text-[11px] text-text-3">Медиана просмотров</dt><dd className="nums mt-1 text-[20px] font-extrabold tabular-nums text-text">{competitor.medianViews == null ? "—" : fmtNum(competitor.medianViews)}</dd></div><div><dt className="text-[11px] text-text-3">Подписчики</dt><dd className="nums mt-1 text-[20px] font-extrabold tabular-nums text-text">{competitor.subscribers == null ? "—" : fmtNum(competitor.subscribers)}</dd></div></dl>
                <p className="mt-4 text-[12px] leading-relaxed text-text-3">{competitor.postsWithMetrics} публикаций с просмотрами{competitor.subscriberGrowth == null ? ". Динамика подписчиков ещё не накоплена." : ` · ${signed(competitor.subscriberGrowth)} подписчиков за период.`}</p>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AnalyticsContent({ data, section, onSectionChange, metric, onMetricChange, channelId, periodDays }: {
  data: StatsData;
  section: AnalyticsSection;
  onSectionChange: (section: AnalyticsSection) => void;
  metric: PostMetric;
  onMetricChange: (metric: PostMetric) => void;
  channelId: number | null;
  periodDays: AnalyticsPeriodDays;
}) {
  if (section === "posts") return <PostsSection data={data} metric={metric} onMetricChange={onMetricChange} />;
  if (section === "growth") return <GrowthSection data={data} />;
  if (section === "competitors") return <CompetitorsSection data={data} channelId={channelId} />;
  if (section === "tracking") return <TrackingAnalyticsSection periodDays={periodDays} channelId={channelId} showPeriodControl={false} />;
  return <OverviewSection data={data} onOpen={onSectionChange} />;
}

function AnalyticsPageContent() {
  const store = useStore();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchString = searchParams.toString();
  const requestedChannelId = safeChannelId(searchParams.get("channel"));
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [periodDays, setPeriodDays] = useState<AnalyticsPeriodDays>(30);
  const [section, setSection] = useState<AnalyticsSection>("overview");
  const [postMetric, setPostMetric] = useState<PostMetric>("views");
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, requestedChannelId);

  const handleChannelChange = (nextChannelId: number) => {
    const params = new URLSearchParams(searchString);
    params.set("channel", String(nextChannelId));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const requestUrl = useMemo(() => channelId ? `/api/stats?channel=${channelId}&days=${periodDays}` : null, [channelId, periodDays]);

  const load = useCallback(async () => {
    if (!requestUrl) {
      setData(null);
      setLoadError(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(false);
    try {
      const response = await fetch(requestUrl, { cache: "no-store" });
      const next = await response.json().catch(() => null) as StatsData | null;
      if (!response.ok || !next) throw new Error("stats_unavailable");
      setData(next);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [requestUrl]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const refresh = useCallback(async () => {
    if (refreshing || !requestUrl) return;
    setRefreshing(true);
    try {
      const queued = await fetch("/api/stats/collect", { method: "POST" });
      if (!queued.ok) throw new Error("stats_queue_unavailable");
      const before = data?.collectedAt ?? null;
      for (let attempt = 0; attempt < 8; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const response = await fetch(requestUrl, { cache: "no-store" });
        if (!response.ok) continue;
        const next = await response.json() as StatsData;
        setData(next);
        if (next.collectedAt && next.collectedAt !== before) {
          store.toast({ kind: "success", title: "Статистика обновлена", body: "Получены свежие показатели публикаций, аудитории и открытых источников." });
          return;
        }
      }
      store.toast({ kind: "info", title: "Сбор ещё идёт", body: "Сохраняем последние подтверждённые данные. Новые значения появятся после ответа внешней сети." });
    } catch {
      store.toast({ kind: "danger", title: "Не удалось запустить сбор", body: "Последние подтверждённые данные сохранены. Попробуйте ещё раз позже." });
    } finally {
      setRefreshing(false);
    }
  }, [data, refreshing, requestUrl, store]);

  const sendReport = useCallback(async () => {
    if (sending) return;
    setSending(true);
    try {
      const response = await fetch("/api/stats/report", { method: "POST" });
      if (response.ok) store.toast({ kind: "success", title: "Недельный отчёт отправлен", body: "Сводка уже доступна в Telegram-боте." });
    } finally {
      setSending(false);
    }
  }, [sending, store]);

  return (
    <AppShell title="Статистика" subtitle="Публикации, рост, конкуренты и переходы — по одному каналу и периоду." action={<div className="grid grid-cols-1 gap-2 min-[24rem]:grid-cols-2"><ProjectExportButton channels={store.realChannels} defaultKind="analytics" initialChannelId={channelId} /><Button variant="primary" onClick={refresh} loading={refreshing}><RefreshCw className="h-4 w-4" aria-hidden />Обновить данные</Button></div>}>
      <section aria-labelledby="channel-statistics-heading" className="space-y-6">
        <div className="sr-only" aria-live="polite">{loading ? "Загружаем статистику выбранного канала." : loadError ? "Не удалось загрузить статистику." : `Открыт раздел ${SECTIONS.find((item) => item.id === section)?.label}.`}</div>
        <Card className="p-4 sm:p-5">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0"><h2 id="channel-statistics-heading" className="text-balance text-[20px] leading-tight font-bold text-text">Аналитика канала</h2><p className="mt-1 max-w-[64ch] text-pretty text-[14px] leading-relaxed text-text-3">Каждый раздел отвечает на отдельный вопрос и использует только фактические данные.</p><ChannelPicker channels={tgChannels} value={channelId} onChange={handleChannelChange} label="Канал" className="mt-4" /></div>
            <div className="w-full lg:w-56"><label htmlFor="analytics-period" className="mb-2 block text-[13px] font-semibold text-text-2">Период</label><select id="analytics-period" className={selectClassName()} value={periodDays} onChange={(event) => setPeriodDays(Number(event.target.value) as AnalyticsPeriodDays)}><option value={7}>Последние 7 дней</option><option value={30}>Последние 30 дней</option><option value={90}>Последние 90 дней</option></select></div>
          </div>
          <nav className="mt-5 flex max-w-full gap-2 overflow-x-auto border-t border-line pt-4" aria-label="Разделы статистики">
            {SECTIONS.map((item) => { const Icon = item.icon; const active = section === item.id; return <button key={item.id} type="button" aria-pressed={active} onClick={() => setSection(item.id)} className={cn("inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xs px-3.5 text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand", active ? "bg-info-soft text-info-text ring-1 ring-brand/30 ring-inset" : "bg-surface-inset text-text-2 hover:text-text")}><Icon className="h-4 w-4" aria-hidden />{item.label}</button>; })}
          </nav>
        </Card>

        {loading ? <div className="space-y-4" aria-busy="true"><div className="skeleton h-32 rounded-md" /><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((item) => <div key={item} className="skeleton h-28 rounded-md" />)}</div><div className="skeleton h-72 rounded-md" /></div> : null}
        {!loading && loadError && !data ? <Card><EmptyState icon={<BarChart3 className="h-6 w-6" aria-hidden />} title="Не удалось загрузить статистику" body="Последние данные не обнулены. Проверьте соединение и повторите загрузку." action={<Button variant="primary" size="sm" onClick={() => void load()}>Попробовать снова</Button>} /></Card> : null}
        {!loading && !loadError && !data?.hasChannel ? <Card><EmptyState icon={<BarChart3 className="h-6 w-6" aria-hidden />} title="Подключите канал" body="После первой публикации и сбора данных здесь появятся графики просмотров, аудитории и сравнение с конкурентами." action={<Link className={buttonClassName({ variant: "primary", size: "sm" })} href="/app/settings?section=channels">Подключить канал</Link>} /></Card> : null}
        {!loading && data?.hasChannel ? <AnalyticsContent data={data} section={section} onSectionChange={setSection} metric={postMetric} onMetricChange={setPostMetric} channelId={channelId} periodDays={periodDays} /> : null}

        {!loading && data?.hasChannel && section !== "tracking" ? <div className="flex flex-col gap-3 rounded-md bg-surface-inset p-4 sm:flex-row sm:items-start sm:justify-between"><div className="flex min-w-0 items-start gap-2.5"><Info className="mt-0.5 h-4 w-4 shrink-0 text-text-3" aria-hidden /><p className="text-[13px] leading-relaxed text-text-2">Показываем просмотры и реакции подтверждённых публикаций, снимки подписчиков и открытые данные конкурентов. Охват и комментарии, которых текущая интеграция не получает, не заменяются нулями.{data.cohort && (data.cohort.missing > 0 || data.cohort.unverified > 0) ? ` Исключено: отсутствующих — ${data.cohort.missing}, неподтверждённых — ${data.cohort.unverified}.` : ""}{data.collectedAt ? ` Последний сбор: ${new Date(data.collectedAt).toLocaleString("ru-RU", { timeZone: data.period?.timeZone })}.` : ""}</p></div><Button variant="ghost" size="sm" className="shrink-0" onClick={sendReport} loading={sending}><Send className="h-4 w-4" aria-hidden />Отправить недельный отчёт</Button></div> : null}
      </section>
    </AppShell>
  );
}

function AnalyticsPageFallback() {
  return (
    <AppShell title="Статистика" subtitle="Публикации, рост, конкуренты и переходы — по одному каналу и периоду.">
      <div className="space-y-4" aria-busy="true">
        <div className="skeleton h-32 rounded-md" />
        <div className="skeleton h-72 rounded-md" />
      </div>
    </AppShell>
  );
}

export default function AnalyticsPage() {
  return <Suspense fallback={<AnalyticsPageFallback />}><AnalyticsPageContent /></Suspense>;
}
