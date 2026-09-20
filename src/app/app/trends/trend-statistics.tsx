"use client";

import { useState } from "react";
import { ExternalLink, Info } from "lucide-react";
import { Card, Tabs } from "@/components/ui/primitives";
import { cn, fmtCompact, plural } from "@/lib/utils";
import type { TrendStatsData } from "@/lib/trend-statistics";

const dateFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", month: "short", timeZone: "Europe/Moscow",
});
const timeFormat = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow",
});
const measurementFormat = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow",
});
const number = (value: number | null) => value == null ? "—" : fmtCompact(value);

export function TrendMetrics({ data }: { data: TrendStatsData }) {
  const { summary } = data;
  const metrics = [
    { label: "Публикации", value: number(summary.posts), detail: "По выбранной теме и периоду" },
    { label: "Источники", value: number(summary.sources), detail: "Каналы с найденными публикациями" },
    { label: "Просмотры публикаций", value: number(summary.views), detail: summary.postsWithViews === 0
      ? "Счётчики недоступны"
      : `Доступны у ${summary.postsWithViews} из ${summary.posts} публикаций` },
    { label: "В среднем на пост", value: number(summary.avgViews), detail: "Среди публикаций с доступными просмотрами" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Показатели выбранной темы">
      {metrics.map((metric) => (
        <Card key={metric.label} className="min-w-0 px-4 py-4 sm:px-5">
          <p className="text-[12px] font-medium text-text-3">{metric.label}</p>
          <p className="nums mt-2 text-[28px] font-bold tracking-tight text-text sm:text-[32px]">{metric.value}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-text-3">{metric.detail}</p>
        </Card>
      ))}
    </div>
  );
}

function chartCeiling(value: number) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value / 4));
  const step = [1, 2, 5, 10].find((candidate) => candidate * magnitude >= value / 4)! * magnitude;
  return step * 4;
}

function ActivityChart({ data }: { data: TrendStatsData }) {
  const [metric, setMetric] = useState<"posts" | "views">("posts");
  const [active, setActive] = useState<number | null>(null);
  const ceiling = chartCeiling(Math.max(0, ...data.series.map((point) => point[metric] ?? 0)));
  const label = metric === "posts" ? "публикаций" : "просмотров";
  const point = active == null ? null : data.series[active];
  const tickStep = Math.max(1, Math.ceil(data.series.length / 7));
  const chartGap = data.series.length > 31 ? "gap-px" : "gap-1.5 sm:gap-2";
  const bucketLabel = (value: string) => data.period === "day"
    ? timeFormat.format(new Date(value)) : dateFormat.format(new Date(value));
  const pointDescription = (entry: TrendStatsData["series"][number]) => {
    const range = `${measurementFormat.format(new Date(entry.bucket))} — ${measurementFormat.format(new Date(entry.until))} МСК`;
    const value = entry[metric];
    const metricText = value == null ? "просмотры недоступны" : `${value.toLocaleString("ru-RU")} ${label}`;
    const coverage = metric === "views" && entry.postsWithViews < entry.posts
      ? `; счётчики у ${entry.postsWithViews} из ${entry.posts} публикаций` : "";
    return `${range}: ${metricText}${coverage}`;
  };
  return (
    <Card className="p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-bold text-text">
            {metric === "posts" ? "Публикации по времени" : "Просмотры по дате публикации"}
          </h2>
          <p className="mt-1 text-[12px] text-text-3">
            {metric === "posts" ? "Когда выходили найденные посты." : "Накопленные просмотры постов по времени их выхода."}
            {data.period === "quarter" ? " Один столбец — до семи дней." : data.period === "day" ? " Один столбец — час." : " Один столбец — день."}
          </p>
        </div>
        <Tabs items={[{ value: "posts", label: "Публикации" }, { value: "views", label: "Просмотры" }]}
          value={metric} onChange={(next) => { setMetric(next); setActive(null); }} ariaLabel="Показатель графика" />
      </div>
      <div className="relative mt-7 h-60 pl-11 sm:h-64" role="group" aria-label={`График: ${label}`}>
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden="true">
          {[4, 3, 2, 1, 0].map((tick) => (
            <div key={tick} className="flex items-center gap-3">
              <span className="nums w-8 shrink-0 text-right text-[10px] text-text-3">{fmtCompact(ceiling * tick / 4)}</span>
              <span className="h-px flex-1 bg-line/70" />
            </div>
          ))}
        </div>
        <div className={cn("relative flex h-full items-end", chartGap)} onMouseLeave={() => setActive(null)}>
          {data.series.map((entry, index) => {
            const value = entry[metric];
            return (
              <button key={entry.bucket} type="button" aria-label={pointDescription(entry)} title={pointDescription(entry)}
                className="group relative flex h-full min-w-0 flex-1 items-end rounded-t focus-visible:outline-2 focus-visible:outline-brand"
                onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onBlur={() => setActive(null)}>
                <span className={cn("w-full rounded-t bg-brand/65 transition-colors group-hover:bg-brand group-focus-visible:bg-brand",
                  value == null && entry.posts > 0 && "border-t-2 border-dashed border-text-3 bg-transparent")}
                  style={{ height: `${((value ?? 0) / ceiling) * 100}%` }} />
              </button>
            );
          })}
        </div>
      </div>
      <div className={cn("mt-3 flex pl-11", chartGap)} aria-hidden="true">
        {data.series.map((entry, index) => (
          <span key={entry.bucket} className="min-w-0 flex-1 text-center text-[10px] text-text-3">
            {index % tickStep === 0 || index === data.series.length - 1 ? bucketLabel(entry.bucket) : ""}
          </span>
        ))}
      </div>
      <p className="mt-4 min-h-9 text-[11px] leading-relaxed text-text-3">
        {point ? pointDescription(point) : metric === "views"
          ? "Это просмотры, накопленные к моменту сбора, а не их прирост за день. Наведи на столбец, чтобы увидеть значение."
          : "Наведи на столбец, чтобы увидеть количество и точный интервал. Время — московское; текущий день ещё не завершён."}
      </p>
    </Card>
  );
}

export function TrendDataDetails({ data }: { data: TrendStatsData }) {
  return (
    <details className="rounded-md border border-line px-4 py-3 text-[12px] text-text-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-text-2">
        <Info className="h-4 w-4" aria-hidden /> Откуда цифры и как считаем
      </summary>
      <div className="mt-3 grid gap-2 leading-relaxed sm:grid-cols-2 sm:gap-x-8">
        <p>Источник — публичные страницы Telegram. Счётчики могут быть округлены самим Telegram.
          Сумма просмотров не означает количество уникальных людей.</p>
        <p>В расчёте {data.summary.posts} публикаций. Просмотры доступны у {data.summary.postsWithViews},
          реакции — у {data.summary.postsWithReactions}. Отсутствующий счётчик обозначаем «—», а не нулём.</p>
        <p>«× к норме» — просмотры поста, делённые на медиану минимум пяти публикаций того же канала.
          Счётчики сравниваем только после 48 часов с момента публикации; база сравнения — до 90 дней.</p>
        <p>Это статистика собранных публикаций. Полнота охвата Telegram и непрерывность сбора не гарантированы,
          поэтому проценты роста темы и объём поискового спроса не рассчитываем.</p>
        {(data.coverage.undatedPosts > 0 || data.coverage.futurePosts > 0) && (
          <p>В расчёт периода не вошли: без даты — {data.coverage.undatedPosts}, с датой в будущем — {data.coverage.futurePosts}.</p>
        )}
        {data.coverage.oldestMeasurementAt && data.coverage.latestMeasurementAt && (
          <p>Счётчики собраны {measurementFormat.format(new Date(data.coverage.oldestMeasurementAt))}
            {data.coverage.oldestMeasurementAt !== data.coverage.latestMeasurementAt
              ? ` — ${measurementFormat.format(new Date(data.coverage.latestMeasurementAt))}` : ""} МСК.</p>
        )}
      </div>
    </details>
  );
}

export function TrendStatistics({ data }: { data: TrendStatsData }) {
  return (
    <section aria-label="Статистика по выбранной теме" className="grid min-w-0 grid-cols-1 gap-5">
      <ActivityChart data={data} />
      {data.topItems.length > 0 && (
        <Card className="overflow-hidden">
          <div className="px-4 py-4 sm:px-6">
            <h2 className="text-[16px] font-bold text-text">Заметные публикации</h2>
            <p className="mt-1 text-[12px] text-text-3">По просмотрам · сначала по одной от каждого источника</p>
          </div>
          <ol className="divide-y divide-line">
            {data.topItems.map((item, index) => (
              <li key={item.link}>
                <a href={item.link} target="_blank" rel="noopener noreferrer"
                  className="flex items-start gap-3 px-4 py-4 transition-colors hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-brand sm:gap-4 sm:px-6">
                  <span className="nums mt-0.5 w-4 shrink-0 text-[12px] text-text-3">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-[13px] font-semibold text-text">{item.competitorTitle || `@${item.handle}`}</span>
                      <span className="text-[11px] text-text-3">{dateFormat.format(new Date(item.postedAt))}</span>
                      {item.ratio != null && item.ratio >= 1.5 && (
                        <span className="text-[11px] font-medium text-brand" title={`Медиана ${number(item.median)} просмотров по ${item.baselinePosts} публикациям`}>
                          ×{item.ratio.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} к норме
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-text-2">{item.text || "Публикация без текста"}</p>
                    <p className="mt-2 text-[11px] text-text-3 sm:hidden">{number(item.views)} просмотров</p>
                  </div>
                  <span className="hidden shrink-0 text-right sm:block">
                    <span className="nums text-[14px] font-semibold text-text">{number(item.views)}</span>
                    <span className="mt-1 block text-[10px] text-text-3">просмотров</span>
                  </span>
                  <ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
                </a>
              </li>
            ))}
          </ol>
          <p className="border-t border-line px-4 py-3 text-[11px] text-text-3 sm:px-6">
            {data.summary.sources} {plural(data.summary.sources, "источник", "источника", "источников")} в выборке. Каждая публикация ведёт к оригиналу.
          </p>
        </Card>
      )}
    </section>
  );
}
