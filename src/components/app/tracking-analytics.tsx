"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, MousePointerClick, RefreshCw } from "lucide-react";

import { useProjects } from "@/components/app/project-provider";
import { Button } from "@/components/ui/button";
import { cn, fmtNum } from "@/lib/utils";

const ALL = "all";
const NONE = "none";
const TRACKER_STATUSES = new Set(["not_connected", "active", "paused", "verification_failed"]);

export interface TrackingReportRow {
  linkId: number;
  slug: string;
  campaign: string | null;
  source: string | null;
  medium: string | null;
  postId: number | null;
  channelId: number | null;
  channelTitle: string | null;
  totalClicks: number;
  uniqueClicks: number;
  confirmedConversions: number;
  formOpens: number;
  formSubmits: number;
  consultations: number;
}

export interface TrackingReport {
  period: { from: string; to: string };
  tracker: {
    status: "not_connected" | "active" | "paused" | "verification_failed";
    siteOrigin: string | null;
    publicKey: string | null;
    attributionWindowDays: number;
    version: number;
    verifiedAt: string | null;
    lastPingAt: string | null;
  };
  methodology: {
    totalClicks: string;
    uniqueClicks: string;
    conversions: string;
    postAttribution: string;
  };
  rows: TrackingReportRow[];
}

export interface TrackingFilters {
  campaign: string;
  channel: string;
  post: string;
}

export interface GroupedTrackingRow {
  linkId: number;
  slug: string;
  campaign: string | null;
  channels: string[];
  posts: string[];
  totalClicks: number;
  uniqueClicks: number;
  confirmedConversions: number;
}

type TrackingViewProps = {
  projectName: string;
  report: TrackingReport | null;
  loading: boolean;
  error: boolean;
  periodDays: number;
  onPeriodChange: (days: number) => void;
  onRetry: () => void;
  className?: string;
  preferredChannelId?: number | null;
  showPeriodControl?: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullableText(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean || null;
}

function isoOrNull(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) return undefined;
  return value;
}

function naturalNumber(value: unknown, allowZero = true): number | null {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) return null;
  return Number(value);
}

function parseTrackingRow(value: unknown): TrackingReportRow | null {
  if (!isObject(value)) return null;
  const linkId = naturalNumber(value.linkId, false);
  const postId = value.postId == null ? null : naturalNumber(value.postId, false);
  const channelId = value.channelId == null ? null : naturalNumber(value.channelId, false);
  const campaign = nullableText(value.campaign);
  const source = nullableText(value.source);
  const medium = nullableText(value.medium);
  const channelTitle = nullableText(value.channelTitle);
  const totalClicks = naturalNumber(value.totalClicks);
  const uniqueClicks = naturalNumber(value.uniqueClicks);
  const confirmedConversions = naturalNumber(value.confirmedConversions);
  const formOpens = naturalNumber(value.formOpens);
  const formSubmits = naturalNumber(value.formSubmits);
  const consultations = naturalNumber(value.consultations);
  if (
    linkId == null
    || typeof value.slug !== "string"
    || !value.slug.trim()
    || campaign === undefined
    || source === undefined
    || medium === undefined
    || channelTitle === undefined
    || (value.postId != null && postId == null)
    || (value.channelId != null && channelId == null)
    || totalClicks == null
    || uniqueClicks == null
    || confirmedConversions == null
    || formOpens == null
    || formSubmits == null
    || consultations == null
  ) return null;
  return {
    linkId,
    slug: value.slug.trim(),
    campaign,
    source,
    medium,
    postId,
    channelId,
    channelTitle,
    totalClicks,
    uniqueClicks,
    confirmedConversions,
    formOpens,
    formSubmits,
    consultations,
  };
}

export function parseTrackingReport(value: unknown): TrackingReport | null {
  if (!isObject(value) || value.ok !== true || !isObject(value.report)) return null;
  const report = value.report;
  if (!isObject(report.period) || !isObject(report.tracker) || !isObject(report.methodology) || !Array.isArray(report.rows)) {
    return null;
  }
  const from = isoOrNull(report.period.from);
  const to = isoOrNull(report.period.to);
  const status = report.tracker.status;
  const siteOrigin = nullableText(report.tracker.siteOrigin);
  const publicKey = nullableText(report.tracker.publicKey);
  const verifiedAt = isoOrNull(report.tracker.verifiedAt);
  const lastPingAt = isoOrNull(report.tracker.lastPingAt);
  const attributionWindowDays = naturalNumber(report.tracker.attributionWindowDays, false);
  const version = naturalNumber(report.tracker.version);
  const rows = report.rows.map(parseTrackingRow);
  if (
    !from
    || !to
    || new Date(from) >= new Date(to)
    || typeof status !== "string"
    || !TRACKER_STATUSES.has(status)
    || siteOrigin === undefined
    || publicKey === undefined
    || verifiedAt === undefined
    || lastPingAt === undefined
    || attributionWindowDays == null
    || version == null
    || typeof report.methodology.totalClicks !== "string"
    || typeof report.methodology.uniqueClicks !== "string"
    || typeof report.methodology.conversions !== "string"
    || typeof report.methodology.postAttribution !== "string"
    || rows.some((row) => row == null)
  ) return null;
  return {
    period: { from, to },
    tracker: {
      status: status as TrackingReport["tracker"]["status"],
      siteOrigin,
      publicKey,
      attributionWindowDays,
      version,
      verifiedAt,
      lastPingAt,
    },
    methodology: {
      totalClicks: report.methodology.totalClicks,
      uniqueClicks: report.methodology.uniqueClicks,
      conversions: report.methodology.conversions,
      postAttribution: report.methodology.postAttribution,
    },
    rows: rows as TrackingReportRow[],
  };
}

function campaignValue(campaign: string | null) {
  return campaign == null ? NONE : `campaign:${encodeURIComponent(campaign)}`;
}

function channelValue(channelId: number | null) {
  return channelId == null ? NONE : `channel:${channelId}`;
}

function postValue(postId: number | null) {
  return postId == null ? NONE : `post:${postId}`;
}

export function filterTrackingRows(rows: TrackingReportRow[], filters: TrackingFilters) {
  return rows.filter((row) => (
    (filters.campaign === ALL || campaignValue(row.campaign) === filters.campaign)
    && (filters.channel === ALL || channelValue(row.channelId) === filters.channel)
    && (filters.post === ALL || postValue(row.postId) === filters.post)
  ));
}

export function groupTrackingRows(rows: TrackingReportRow[]): GroupedTrackingRow[] {
  const grouped = new Map<string, GroupedTrackingRow>();
  for (const row of rows) {
    const groupKey = `${row.linkId}:${row.slug}`;
    const current = grouped.get(groupKey);
    const channel = row.channelTitle ?? (row.channelId == null ? "Канал не привязан" : `Канал №${row.channelId}`);
    const post = row.postId == null ? "Публикация не привязана" : `Публикация №${row.postId}`;
    if (!current) {
      grouped.set(groupKey, {
        linkId: row.linkId,
        slug: row.slug,
        campaign: row.campaign,
        channels: [channel],
        posts: [post],
        totalClicks: row.totalClicks,
        uniqueClicks: row.uniqueClicks,
        confirmedConversions: row.confirmedConversions,
      });
      continue;
    }
    if (!current.channels.includes(channel)) current.channels.push(channel);
    if (!current.posts.includes(post)) current.posts.push(post);
    current.totalClicks += row.totalClicks;
    current.uniqueClicks += row.uniqueClicks;
    current.confirmedConversions += row.confirmedConversions;
  }
  return [...grouped.values()].sort((a, b) => b.linkId - a.linkId || a.slug.localeCompare(b.slug, "ru"));
}

export function trackingPeriod(days: number, now = new Date()) {
  const safeDays = [1, 7, 30, 90].includes(days) ? days : 30;
  return {
    from: new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1_000).toISOString(),
    to: now.toISOString(),
  };
}

function formatPeriod(report: TrackingReport) {
  const formatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });
  return `${formatter.format(new Date(report.period.from))} — ${formatter.format(new Date(report.period.to))}`;
}

function selectClassName() {
  return "min-h-11 w-full rounded-xs border border-line bg-surface px-3 text-base text-text focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[14px]";
}

function selectionLabel(value: string, options: Array<{ value: string; label: string }>, fallback: string) {
  return options.find((option) => option.value === value)?.label ?? fallback;
}

export function TrackingAnalyticsView({
  projectName,
  report,
  loading,
  error,
  periodDays,
  onPeriodChange,
  onRetry,
  className,
  preferredChannelId = null,
  showPeriodControl = true,
}: TrackingViewProps) {
  const [campaign, setCampaign] = useState(ALL);
  const [channel, setChannel] = useState(preferredChannelId == null ? ALL : channelValue(preferredChannelId));
  const [post, setPost] = useState(ALL);

  const campaignOptions = useMemo(() => {
    if (!report) return [];
    const values = new Map<string, string>();
    for (const row of report.rows) values.set(campaignValue(row.campaign), row.campaign ?? "Без кампании");
    return [...values].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "ru"));
  }, [report]);
  const selectedCampaign = campaign === ALL || campaignOptions.some((option) => option.value === campaign)
    ? campaign
    : ALL;
  const campaignRows = useMemo(
    () => report ? filterTrackingRows(report.rows, { campaign: selectedCampaign, channel: ALL, post: ALL }) : [],
    [report, selectedCampaign],
  );
  const channelOptions = useMemo(() => {
    const values = new Map<string, string>();
    for (const row of campaignRows) {
      values.set(channelValue(row.channelId), row.channelTitle ?? (row.channelId == null ? "Без канала" : `Канал №${row.channelId}`));
    }
    return [...values].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "ru"));
  }, [campaignRows]);
  const selectedChannel = channel === ALL || channelOptions.some((option) => option.value === channel)
    ? channel
    : ALL;
  const channelRows = useMemo(
    () => filterTrackingRows(campaignRows, { campaign: ALL, channel: selectedChannel, post: ALL }),
    [campaignRows, selectedChannel],
  );
  const postOptions = useMemo(() => {
    const values = new Map<string, string>();
    for (const row of channelRows) values.set(postValue(row.postId), row.postId == null ? "Без публикации" : `Публикация №${row.postId}`);
    return [...values].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "ru"));
  }, [channelRows]);
  const selectedPost = post === ALL || postOptions.some((option) => option.value === post)
    ? post
    : ALL;

  const filtered = useMemo(
    () => report ? filterTrackingRows(report.rows, {
      campaign: selectedCampaign,
      channel: selectedChannel,
      post: selectedPost,
    }) : [],
    [report, selectedCampaign, selectedChannel, selectedPost],
  );
  const grouped = useMemo(() => groupTrackingRows(filtered), [filtered]);
  const totals = grouped.reduce(
    (sum, row) => ({
      totalClicks: sum.totalClicks + row.totalClicks,
      uniqueClicks: sum.uniqueClicks + row.uniqueClicks,
      confirmedConversions: sum.confirmedConversions + row.confirmedConversions,
    }),
    { totalClicks: 0, uniqueClicks: 0, confirmedConversions: 0 },
  );
  const trackerConnected = report?.tracker.status === "active";

  return (
    <section className={cn("space-y-4", className)} aria-labelledby="tracking-analytics-heading">
      <div>
        <h2 id="tracking-analytics-heading" className="text-balance text-[20px] leading-tight font-bold text-text">
          Переходы и заявки
        </h2>
        <p className="mt-1 max-w-[68ch] text-pretty text-[14px] leading-relaxed text-text-3">
          Путь от короткой ссылки до подтверждённого действия на сайте. Числа относятся только к выбранному проекту и периоду.
        </p>
      </div>

      <div className="card-plain min-w-0 rounded-md p-4 sm:p-5">
        {showPeriodControl ? <div className="max-w-xs">
          <label htmlFor="tracking-period" className="mb-2 block text-[13px] font-semibold text-text-2">
            Период отчёта
          </label>
          <select
            id="tracking-period"
            value={String(periodDays)}
            onChange={(event) => onPeriodChange(Number(event.target.value))}
            className={selectClassName()}
          >
            <option value="1">Последние 24 часа</option>
            <option value="7">Последние 7 дней</option>
            <option value="30">Последние 30 дней</option>
            <option value="90">Последние 90 дней</option>
          </select>
        </div> : null}

        <div className="sr-only" role="status" aria-live="polite">
          {loading
            ? "Загружаем переходы и заявки."
            : error
              ? ""
              : report
                ? `Показано коротких ссылок: ${grouped.length}. Всего переходов: ${totals.totalClicks}. Уникальных: ${totals.uniqueClicks}. Подтверждённых конверсий: ${totals.confirmedConversions}.`
                : ""}
        </div>

        {loading ? (
          <div className="mt-6 space-y-3" aria-hidden="true">
            <div className="skeleton h-16 w-full rounded-sm" />
            <div className="skeleton h-32 w-full rounded-sm" />
          </div>
        ) : error || !report ? (
          <div role="alert" className="mt-6 rounded-sm bg-danger-soft p-4 text-danger-text">
            <p className="font-semibold">Не удалось загрузить переходы и заявки</p>
            <p className="mt-1 max-w-[62ch] text-[14px] leading-relaxed">
              Данные проекта не изменились. Проверь подключение и повтори загрузку.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={onRetry} className="mt-3">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Повторить загрузку
            </Button>
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            {!trackerConnected && (
              <div className="flex flex-col gap-3 rounded-sm bg-surface-inset p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-text-3" aria-hidden="true" />
                  <div className="min-w-0">
                    <h3 className="font-semibold text-text">Трекер сайта не подключён</h3>
                    <p className="mt-1 max-w-[62ch] text-pretty text-[14px] leading-relaxed text-text-2">
                      Переходы по коротким ссылкам продолжат считаться. Подтверждённые заявки появятся только после подключения и проверки трекера на сайте.
                    </p>
                  </div>
                </div>
                <Link
                  href="/app/settings#tracking"
                  className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-[10px] border border-line-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-text transition-[background-color,border-color,transform] duration-200 hover:bg-surface-2 active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none"
                >
                  Открыть настройки
                </Link>
              </div>
            )}

            <fieldset>
              <legend className="text-[15px] font-bold text-text">Срез отчёта</legend>
              <div className="mt-3 grid gap-4 md:grid-cols-3">
                <label className="block min-w-0 text-[13px] font-semibold text-text-2">
                  Кампания
                  <select
                    value={selectedCampaign}
                    onChange={(event) => {
                      setCampaign(event.target.value);
                      setChannel(ALL);
                      setPost(ALL);
                    }}
                    className={cn("mt-2", selectClassName())}
                  >
                    <option value={ALL}>Все кампании</option>
                    {campaignOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="block min-w-0 text-[13px] font-semibold text-text-2">
                  Канал
                  <select
                    value={selectedChannel}
                    onChange={(event) => {
                      setChannel(event.target.value);
                      setPost(ALL);
                    }}
                    className={cn("mt-2", selectClassName())}
                  >
                    <option value={ALL}>Все каналы</option>
                    {channelOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="block min-w-0 text-[13px] font-semibold text-text-2">
                  Публикация
                  <select value={selectedPost} onChange={(event) => setPost(event.target.value)} className={cn("mt-2", selectClassName())}>
                    <option value={ALL}>Все публикации</option>
                    {postOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
              </div>
            </fieldset>

            <ol aria-label="Путь выбранного среза" className="grid gap-x-5 gap-y-3 border-y border-line py-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Проект", projectName],
                ["Кампания", selectionLabel(selectedCampaign, campaignOptions, "Все кампании")],
                ["Канал", selectionLabel(selectedChannel, channelOptions, "Все каналы")],
                ["Публикация", selectionLabel(selectedPost, postOptions, "Все публикации")],
              ].map(([label, value], index) => (
                <li key={label} className="min-w-0 break-words [overflow-wrap:anywhere]">
                  <span className="mr-2 text-text-3" aria-hidden="true">{index + 1}</span>
                  <span className="font-semibold text-text-2">{label}:</span>{" "}
                  <span className="text-text">{value}</span>
                </li>
              ))}
            </ol>

            <div>
              <p className="text-[13px] text-text-3">{formatPeriod(report)}</p>
              <ol aria-label="Воронка переходов и заявок" className="mt-3 grid overflow-hidden rounded-sm bg-surface-inset sm:grid-cols-3 sm:divide-x sm:divide-line">
                {[
                  ["Все переходы", totals.totalClicks],
                  ["Уникальные переходы", totals.uniqueClicks],
                  ["Подтверждённые конверсии", totals.confirmedConversions],
                ].map(([label, value]) => (
                  <li key={label} className="min-w-0 border-b border-line p-4 last:border-b-0 sm:border-b-0">
                    <p className="text-pretty text-[13px] leading-snug font-semibold text-text-2">{label}</p>
                    <p className="nums mt-2 text-[28px] leading-none font-extrabold tabular-nums text-text">{fmtNum(Number(value))}</p>
                  </li>
                ))}
              </ol>
              {!trackerConnected && (
                <p className="mt-2 text-[13px] leading-relaxed text-text-3">
                  Ноль подтверждённых конверсий при отключённом трекере не означает, что заявок на сайте не было.
                </p>
              )}
            </div>

            {grouped.length === 0 ? (
              <div className="py-5 text-center">
                <MousePointerClick className="mx-auto h-6 w-6 text-text-3" aria-hidden="true" />
                <p className="mt-2 font-semibold text-text">Коротких ссылок пока нет</p>
                <p className="mx-auto mt-1 max-w-[58ch] text-pretty text-[14px] leading-relaxed text-text-3">
                  Создай короткую ссылку в Композиторе или выбери другой период. Нулевые значения сохранены без подмены данных.
                </p>
              </div>
            ) : (
              <div>
                <h3 className="text-[15px] font-bold text-text">Короткие ссылки в выбранном срезе</h3>
                <div
                  className="mt-3 max-w-full overflow-x-auto rounded-sm border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  role="region"
                  aria-label="Таблица переходов и подтверждённых конверсий"
                  tabIndex={0}
                >
                  <table className="w-full min-w-[760px] border-collapse text-start text-[13px]">
                    <caption className="sr-only">
                      Переходы и подтверждённые конверсии коротких ссылок проекта {projectName}
                    </caption>
                    <thead className="bg-surface-inset text-text-2">
                      <tr>
                        <th scope="col" className="px-3 py-3 text-start font-semibold">Короткая ссылка</th>
                        <th scope="col" className="px-3 py-3 text-start font-semibold">Кампания</th>
                        <th scope="col" className="px-3 py-3 text-start font-semibold">Канал</th>
                        <th scope="col" className="px-3 py-3 text-start font-semibold">Публикация</th>
                        <th scope="col" className="px-3 py-3 text-end font-semibold">Все переходы</th>
                        <th scope="col" className="px-3 py-3 text-end font-semibold">Уникальные</th>
                        <th scope="col" className="px-3 py-3 text-end font-semibold">Конверсии</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {grouped.map((row) => (
                        <tr key={`${row.linkId}:${row.slug}`}>
                          <th scope="row" className="max-w-44 break-all px-3 py-3 text-start font-semibold text-text">/r/{row.slug}</th>
                          <td className="max-w-44 break-words px-3 py-3 text-text-2 [overflow-wrap:anywhere]">{row.campaign ?? "Без кампании"}</td>
                          <td className="max-w-48 break-words px-3 py-3 text-text-2 [overflow-wrap:anywhere]">{row.channels.join(", ")}</td>
                          <td className="max-w-48 break-words px-3 py-3 text-text-2 [overflow-wrap:anywhere]">{row.posts.join(", ")}</td>
                          <td className="nums px-3 py-3 text-end font-semibold tabular-nums text-text">{fmtNum(row.totalClicks)}</td>
                          <td className="nums px-3 py-3 text-end font-semibold tabular-nums text-text">{fmtNum(row.uniqueClicks)}</td>
                          <td className="nums px-3 py-3 text-end font-semibold tabular-nums text-text">{fmtNum(row.confirmedConversions)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <details className="rounded-sm bg-surface-inset px-4">
              <summary className="flex min-h-11 cursor-pointer items-center py-2 text-[13px] font-semibold text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                Как считаются показатели
              </summary>
              <dl className="space-y-3 text-[13px] leading-relaxed text-text-2">
                <div>
                  <dt className="font-semibold text-text">Все переходы</dt>
                  <dd className="mt-0.5">{report.methodology.totalClicks}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-text">Уникальные переходы</dt>
                  <dd className="mt-0.5">{report.methodology.uniqueClicks}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-text">Подтверждённые конверсии</dt>
                  <dd className="mt-0.5">{report.methodology.conversions}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-text">Привязка к публикации</dt>
                  <dd className="mt-0.5">{report.methodology.postAttribution}</dd>
                </div>
              </dl>
              <p className="pt-3 pb-4 text-[13px] leading-relaxed text-text-2">
                Итоги короткой ссылки складываются из отдельных адресов публикаций и переходов без привязки к посту. Один переход входит только в один срез.
              </p>
            </details>
          </div>
        )}
      </div>
    </section>
  );
}

export function TrackingAnalyticsSection({
  className,
  periodDays: controlledPeriodDays,
  channelId = null,
  showPeriodControl = true,
}: {
  className?: string;
  periodDays?: number;
  channelId?: number | null;
  showPeriodControl?: boolean;
}) {
  const { current, ready, error: projectError, refresh: refreshProjects } = useProjects();
  const [localPeriodDays, setLocalPeriodDays] = useState(30);
  const periodDays = controlledPeriodDays ?? localPeriodDays;
  const [state, setState] = useState<{
    key: string | null;
    report: TrackingReport | null;
    status: "loading" | "ready" | "error";
  }>({ key: null, report: null, status: "loading" });
  const requestSequence = useRef(0);
  const projectId = current?.id ?? null;
  const requestKey = projectId == null ? null : `${projectId}:${periodDays}:${channelId ?? "all"}`;

  const load = useCallback(async (signal?: AbortSignal) => {
    if (projectId == null) return;
    const sequence = ++requestSequence.current;
    const key = `${projectId}:${periodDays}:${channelId ?? "all"}`;
    setState({ key, report: null, status: "loading" });
    const period = trackingPeriod(periodDays);
    const search = new URLSearchParams({ from: period.from, to: period.to });
    try {
      const response = await fetch(`/api/tracking/report?${search}`, { cache: "no-store", signal });
      const body = await response.json().catch(() => null);
      const parsed = response.ok ? parseTrackingReport(body) : null;
      if (!parsed) throw new Error("tracking_report_unavailable");
      if (sequence !== requestSequence.current || signal?.aborted) return;
      setState({ key, report: parsed, status: "ready" });
    } catch (error) {
      if (sequence !== requestSequence.current || signal?.aborted || (error instanceof Error && error.name === "AbortError")) return;
      setState({ key, report: null, status: "error" });
    }
  }, [channelId, periodDays, projectId]);

  useEffect(() => {
    if (projectId == null) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load, projectId]);

  const stateMatches = requestKey != null && state.key === requestKey;
  const loading = !ready || (projectId != null && (!stateMatches || state.status === "loading"));
  const error = Boolean(projectError || (stateMatches && state.status === "error") || (ready && projectId == null));
  const report = stateMatches ? state.report : null;

  const retry = useCallback(() => {
    if (projectError) {
      void refreshProjects().then(() => void load());
      return;
    }
    void load();
  }, [load, projectError, refreshProjects]);

  return (
    <TrackingAnalyticsView
      key={requestKey ?? "no-project"}
      projectName={current?.name ?? "Проект не выбран"}
      report={report}
      loading={loading}
      error={error}
      periodDays={periodDays}
      onPeriodChange={setLocalPeriodDays}
      onRetry={retry}
      className={className}
      preferredChannelId={channelId}
      showPeriodControl={showPeriodControl}
    />
  );
}
