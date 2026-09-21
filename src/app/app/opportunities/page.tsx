"use client";

import { useProjectFetch } from "@/lib/use-project-transport";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  Bookmark,
  BookmarkCheck,
  BriefcaseBusiness,
  CalendarCheck2,
  CheckCircle2,
  ChevronDown,
  Clock3,
  ExternalLink,
  Eye,
  EyeOff,
  Grid2X2,
  Info,
  Lightbulb,
  List,
  Newspaper,
  RefreshCw,
  Sparkles,
  Target,
  X,
} from "lucide-react";

import { ChannelPicker, channelName, useChannelChoice } from "@/components/app/channel-picker";
import { AppShell } from "@/components/app/shell";
import { EvidenceCard } from "@/components/app/evidence-card";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { Caption, H2, H3, SecondaryText } from "@/components/ui/typography";
import type { OpportunityMapContext, OpportunitySnapshot } from "@/lib/content-intelligence";
import {
  classifyOpportunityFailure,
  opportunityActionError,
  type OpportunityPageStatus,
} from "@/lib/opportunities-client-state";
import { opportunityStudioHref } from "@/lib/opportunity-studio";
import { useStore } from "@/lib/store";
import { cn, fmtAgo, plural } from "@/lib/utils";

const confidenceLabel = { low: "Низкая уверенность", medium: "Средняя уверенность", high: "Высокая уверенность" } as const;
const opportunityTypeLabel = {
  breaking_news: "Свежая новость",
  rising_topic: "Растущая тема",
  evergreen_gap: "Базовая возможность",
  competitor_gap: "Пробел относительно конкурентов",
  audience_need: "Запрос аудитории",
  offer_gap: "Возможность для предложения",
} as const;
type OpportunityFilter = "all" | OpportunitySnapshot["opportunityType"];
type OpportunityView = "active" | "saved" | "used" | "hidden";

const NEWS_VIEW_COPY: Record<OpportunityView, { title: string; body: string }> = {
  active: {
    title: "Для вас сегодня",
    body: "Аврора отобрала свежие события и растущие темы, которые можно превратить в полезный контент.",
  },
  saved: {
    title: "Сохранённые инфоповоды",
    body: "Материалы, к которым вы решили вернуться позже.",
  },
  used: {
    title: "Использованные инфоповоды",
    body: "События, по которым уже создавался материал.",
  },
  hidden: {
    title: "Скрытые инфоповоды",
    body: "Материалы, убранные из основной подборки. Их можно вернуть в любой момент.",
  },
};

function publishWindowLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `Лучше опубликовать до ${new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date)}`;
}

function safeChannelId(value: string | null): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function opportunityCountLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} актуальных возможностей`;
  if (last === 1) return `${count} актуальная возможность`;
  if (last >= 2 && last <= 4) return `${count} актуальные возможности`;
  return `${count} актуальных возможностей`;
}

function priorityMeta(score: number): {
  label: string;
  tone: "danger" | "fire" | "neutral";
} {
  if (score >= 75) return { label: "Высокий приоритет", tone: "danger" };
  if (score >= 55) return { label: "Важно", tone: "fire" };
  return { label: "Можно запланировать", tone: "neutral" };
}

function opportunityStateMeta(item: OpportunitySnapshot, view: OpportunityView): {
  label: string;
  tone: "brand" | "neutral" | "success";
  icon: "fresh" | "saved" | "used" | "hidden";
} {
  if (view === "used" || item.userState === "used") {
    return { label: "Использован", tone: "success", icon: "used" };
  }
  if (view === "hidden" || item.userState === "dismissed" || item.userState === "not_relevant") {
    return { label: "Скрыт", tone: "neutral", icon: "hidden" };
  }
  if (item.userState === "saved") {
    return { label: "Сохранён", tone: "brand", icon: "saved" };
  }
  return { label: "Актуален", tone: "brand", icon: "fresh" };
}

function NewsOpportunityCard({
  item,
  view,
  creating,
  mutating,
  onCreate,
  onState,
  onRestore,
}: {
  item: OpportunitySnapshot;
  view: OpportunityView;
  creating: boolean;
  mutating: boolean;
  onCreate: (item: OpportunitySnapshot) => void;
  onState: (item: OpportunitySnapshot, state: "saved" | "not_relevant") => void;
  onRestore: (item: OpportunitySnapshot) => void;
}) {
  const priority = priorityMeta(item.priorityScore);
  const state = opportunityStateMeta(item, view);
  const detailsId = `opportunity-details-${item.id}`;
  const source = item.sources[0] ?? null;
  const publishWindow = publishWindowLabel(item.publishBefore);

  return (
    <Card
      as="article"
      data-ui="opportunity-card"
      data-opportunity-id={item.id}
      className={cn(
        "overflow-hidden transition-[background-color,box-shadow,opacity] duration-150 motion-reduce:transition-none",
        state.icon === "fresh" && "bg-surface ring-1 ring-brand/15",
        state.icon === "hidden" && "bg-surface-inset/65",
      )}
    >
      <div className="p-4 sm:p-5 lg:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={state.tone} className="nums">
              {state.icon === "fresh" ? <Sparkles className="h-3.5 w-3.5" aria-hidden /> : null}
              {state.icon === "saved" ? <BookmarkCheck className="h-3.5 w-3.5" aria-hidden /> : null}
              {state.icon === "used" ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : null}
              {state.icon === "hidden" ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : null}
              {state.label}
            </Badge>
            <Badge tone={priority.tone}>
              {priority.tone === "danger" ? <Clock3 className="h-3.5 w-3.5" aria-hidden /> : <Lightbulb className="h-3.5 w-3.5" aria-hidden />}
              {priority.label}
            </Badge>
            <Badge tone="brand">
              <Newspaper className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              {opportunityTypeLabel[item.opportunityType]}
            </Badge>
            <Badge tone={item.confidence === "high" ? "success" : "neutral"}>
              {confidenceLabel[item.confidence]}
            </Badge>
          </div>
          <Caption className="nums shrink-0 text-text-3">{item.freshnessLabel}</Caption>
        </div>

        <H3 className="mt-4 max-w-[88ch] line-clamp-4 text-balance" title={item.title}>
          {item.title}
        </H3>
        <SecondaryText className="mt-2.5 max-w-[90ch] line-clamp-3 text-pretty" title={item.angle}>
          {item.angle}
        </SecondaryText>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-sm border border-brand/10 bg-info-soft/55 p-4">
            <div className="flex items-center gap-2 text-info-text">
              <Target className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
              <Caption className="font-bold tracking-[0.06em] uppercase">Почему сейчас</Caption>
            </div>
            <SecondaryText className="mt-1.5 text-pretty">
              {item.whyNow || `${item.freshnessLabel}. Сигнал подходит тематике выбранного канала.`}
            </SecondaryText>
          </div>
          <div className="rounded-sm border border-line bg-surface-inset/55 p-4">
            <div className="flex items-center gap-2 text-text-2">
              <BriefcaseBusiness className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
              <Caption className="font-bold tracking-[0.06em] uppercase">Идея подачи</Caption>
            </div>
            <SecondaryText className="mt-1.5 text-pretty">
              {item.formatSuggestion || "Разобрать событие своими словами и объяснить его практический смысл для аудитории."}
            </SecondaryText>
          </div>
        </div>

        <details className="group mt-4">
          <summary className="flex min-h-11 w-full cursor-pointer list-none items-center justify-between gap-3 rounded-xs border border-line bg-surface px-4 py-2.5 text-left type-label text-text-2 transition-[background-color,border-color,color] duration-150 hover:border-line-strong hover:bg-surface-inset/45 hover:text-text focus-visible:ring-4 focus-visible:ring-brand/15 motion-reduce:transition-none">
            <span>Подробнее о событии</span>
            <ArrowRight className="h-4 w-4 shrink-0 rotate-90 transition-transform duration-200 group-open:-rotate-90 motion-reduce:transition-none" aria-hidden />
          </summary>
          <div id={detailsId} className="mt-2 overflow-hidden rounded-sm border border-line bg-surface">
            <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(220px,0.65fr)]">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-text-2">
                  <Newspaper className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                  <Caption className="font-bold tracking-[0.06em] uppercase">Суть события</Caption>
                </div>
                <SecondaryText className="mt-1.5 text-pretty">{item.angle}</SecondaryText>
              </div>
              <div className="min-w-0 lg:border-l lg:border-line lg:pl-4">
                <div className="flex items-center gap-2 text-text-2">
                  <Target className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                  <Caption className="font-bold tracking-[0.06em] uppercase">Контекст сигнала</Caption>
                </div>
                <SecondaryText className="mt-1.5 text-pretty">
                  {confidenceLabel[item.confidence]} · {item.sourceCount || 1} {plural(item.sourceCount || 1, "источник", "источника", "источников")}
                </SecondaryText>
              </div>
            </div>
            <div className="border-t border-line bg-surface-inset/35 p-4">
              <div className="flex items-center gap-2 text-text-2">
                <Lightbulb className="h-4 w-4 shrink-0 text-brand" aria-hidden />
                <Caption className="font-bold tracking-[0.06em] uppercase">Как это найдено</Caption>
              </div>
              <SecondaryText className="mt-1.5 text-pretty">{item.methodology}</SecondaryText>
              <Caption className="mt-2 max-w-[92ch] text-pretty text-text-3">
                Перед публикацией проверьте факты и исходные материалы.
              </Caption>
            </div>
          </div>
        </details>
        {publishWindow ? <Caption className="mt-3 font-semibold text-fire-text">{publishWindow}</Caption> : null}
      </div>

      <div className="flex flex-col gap-3 border-t border-line bg-surface-inset/25 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5 lg:px-6">
        {source ? (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="type-caption inline-flex min-h-11 min-w-0 max-w-full items-center gap-1.5 font-semibold text-text-2 underline-offset-4 hover:text-brand hover:underline focus-visible:rounded-xs focus-visible:ring-4 focus-visible:ring-brand/15"
          >
            <span className="truncate">{source.label || item.sourceLabel || "Источник"}</span>
            <span aria-hidden className="text-text-3">·</span>
            <span className="shrink-0 text-brand">Открыть источник</span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </a>
        ) : (
          <EvidenceCard kind="opportunity" id={item.id} label="Проверить основания" />
        )}

        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
          {view === "hidden" ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              loading={mutating}
              onClick={() => onRestore(item)}
              className="col-span-2 w-full sm:w-auto"
            >
              <Eye className="h-4 w-4" aria-hidden />
              Вернуть в подборку
            </Button>
          ) : (
            <>
              <Button
                type="button"
                data-aurora-feature="opportunity"
                data-aurora-action="saved"
                variant="secondary"
                size="sm"
                disabled={mutating || creating}
                aria-pressed={item.userState === "saved"}
                onClick={() => onState(item, "saved")}
                className="w-full sm:w-auto"
              >
                {item.userState === "saved" ? <BookmarkCheck className="h-4 w-4" aria-hidden /> : <Bookmark className="h-4 w-4" aria-hidden />}
                {item.userState === "saved" ? "Сохранено" : "Сохранить"}
              </Button>
              <Button
                type="button"
                data-aurora-feature="opportunity"
                data-aurora-action="hidden"
                variant="secondary"
                size="sm"
                disabled={mutating || creating}
                onClick={() => onState(item, "not_relevant")}
                className="w-full sm:w-auto"
              >
                <EyeOff className="h-4 w-4" aria-hidden />
                Скрыть
              </Button>
              <Button
                type="button"
                data-aurora-feature="opportunity"
                data-aurora-action="used"
                variant="brand"
                size="sm"
                loading={creating}
                disabled={mutating || !item.actionable}
                onClick={() => onCreate(item)}
                className="col-span-2 w-full sm:w-auto"
              >
                {view === "used" ? <CalendarCheck2 className="h-4 w-4" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                {view === "used" ? "Создать ещё вариант" : "Создать пост"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function OpportunityDetails({
  item,
  creating,
  onCreate,
  onState,
  mutating,
  className,
  titleId,
  createLabel = "Создать черновик",
  view = "active",
  onRestore,
}: {
  item: OpportunitySnapshot;
  creating: boolean;
  onCreate: (item: OpportunitySnapshot) => void;
  onState: (item: OpportunitySnapshot, state: "saved" | "not_relevant") => void;
  mutating: boolean;
  className?: string;
  titleId: string;
  createLabel?: string;
  view?: OpportunityView;
  onRestore?: (item: OpportunitySnapshot) => void;
}) {
  return (
    <Card strong className={cn("overflow-hidden", className)}>
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={item.opportunityType === "breaking_news" ? "fire" : "brand"}>{opportunityTypeLabel[item.opportunityType]}</Badge>
            <Badge tone={item.epistemicState === "inferred" ? "brand" : "neutral"}>
              {item.epistemicState === "inferred" ? "Объяснимый вывод" : "Гипотеза для проверки"}
            </Badge>
          </div>
          <span className="type-caption text-text-3">{item.channelLabel}</span>
        </div>
        <h2 id={titleId} className="mt-4 text-balance text-[22px] leading-tight tracking-tight">
          {item.title}
        </h2>
        <p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">
          {item.angle}
        </p>
        {item.whyNow && <p className="mt-4 rounded-sm bg-brand-soft p-3 text-[14px] leading-relaxed text-text"><span className="font-semibold">Почему сейчас:</span> {item.whyNow}</p>}
        {publishWindowLabel(item.publishBefore) && <p className="mt-3 text-[13px] font-semibold text-fire-text">{publishWindowLabel(item.publishBefore)}</p>}
        <dl className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
          <div className="min-w-0 rounded-sm bg-surface-inset p-3">
            <dt className="type-caption text-text-3">Спрос</dt>
            <dd className="mt-1 font-semibold tabular-nums">{item.demand} из 4</dd>
          </div>
          <div className="min-w-0 rounded-sm bg-surface-inset p-3">
            <dt className="type-caption text-text-3">Покрытие</dt>
            <dd className="mt-1 font-semibold tabular-nums">{item.coverage} из 4</dd>
          </div>
          <div className="min-w-0 rounded-sm bg-surface-inset p-3">
            <dt className="type-caption text-text-3">Источники</dt>
            <dd className="mt-1 break-words font-semibold tabular-nums">{item.sourceCount || "Профиль"}</dd>
          </div>
          <div className="min-w-0 rounded-sm bg-surface-inset p-3">
            <dt className="type-caption text-text-3">Приоритет</dt>
            <dd className="mt-1 font-semibold tabular-nums">{item.priorityScore} из 100</dd>
          </div>
        </dl>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {view === "hidden" ? (
            <Button variant="primary" className="w-full sm:w-auto" loading={mutating} onClick={() => onRestore?.(item)}>
              Вернуть в подборку
            </Button>
          ) : (
            <>
              <Button
                variant="primary"
                className="w-full sm:w-auto"
                disabled={!item.actionable}
                loading={creating}
                onClick={() => onCreate(item)}
              >
                <Sparkles className="h-4 w-4" aria-hidden />
                {view === "used" ? "Создать ещё вариант" : createLabel}
              </Button>
              <Button variant="secondary" disabled={mutating} aria-pressed={item.userState === "saved"} onClick={() => onState(item, "saved")}>
                <Bookmark className="h-4 w-4" aria-hidden />
                {item.userState === "saved" ? "Сохранено" : "Сохранить"}
              </Button>
              <Button variant="ghost" disabled={mutating} onClick={() => onState(item, "not_relevant")}>
                <X className="h-4 w-4" aria-hidden />Не подходит
              </Button>
            </>
          )}
          <EvidenceCard kind="opportunity" id={item.id} label="Проверить основания" />
        </div>
        {!item.actionable && (
          <p className="mt-3 flex items-start gap-2 text-[13px] leading-relaxed text-fire-text">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Для черновика пока недостаточно подтверждённых данных.
          </p>
        )}
      </div>
      <details className="group border-t border-line px-5 sm:px-6">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 font-semibold text-text focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
          <span>Источник и методика</span>
          <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" aria-hidden />
        </summary>
        <div className="space-y-3 pb-6 text-[14px] leading-relaxed text-text-2">
          <p><span className="font-semibold text-text">Источник:</span> {item.sourceType}{item.sourceLabel ? ` · ${item.sourceLabel}` : ""}</p>
          <p><span className="font-semibold text-text">Актуальность:</span> {item.freshnessLabel}</p>
          <p><span className="font-semibold text-text">Методика:</span> {item.methodology}</p>
          {item.formatSuggestion && <p><span className="font-semibold text-text">Рекомендуемый формат:</span> {item.formatSuggestion}</p>}
          {item.sources.length > 0 && <div><p className="font-semibold text-text">Открытые источники:</p><ul className="mt-2 space-y-2">{item.sources.map((source) => <li key={source.url}><a className="break-words font-semibold text-brand underline underline-offset-4" href={source.url} target="_blank" rel="noreferrer">{source.label || new URL(source.url).hostname}</a></li>)}</ul></div>}
          <p className="type-caption tabular-nums text-text-3">Версия расчёта: {item.formulaVersion}</p>
        </div>
      </details>
    </Card>
  );
}

function OpportunityWorkspace() {
  const fetch = useProjectFetch();
  const store = useStore();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isNews = pathname === "/app/rss";
  const requestedView = searchParams.get("view");
  const opportunityView: OpportunityView = isNews && (
    requestedView === "saved" || requestedView === "used" || requestedView === "hidden"
  ) ? requestedView : "active";
  const searchString = searchParams.toString();
  const requestedChannelId = safeChannelId(searchParams.get("channel"));
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, requestedChannelId);
  const [items, setItems] = useState<OpportunitySnapshot[]>([]);
  const [context, setContext] = useState<OpportunityMapContext | null>(null);
  const [status, setStatus] = useState<OpportunityPageStatus>("loading");
  const [operationError, setOperationError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [creatingId, setCreatingId] = useState<number | null>(null);
  const [mutatingId, setMutatingId] = useState<number | null>(null);
  const [dismissedItem, setDismissedItem] = useState<OpportunitySnapshot | null>(null);
  const [filter, setFilter] = useState<OpportunityFilter>("all");
  const [view, setView] = useState<"list" | "map">("list");
  const requested = Number(searchParams.get("opportunity"));
  const [selectedId, setSelectedId] = useState<number | null>(Number.isSafeInteger(requested) && requested > 0 ? requested : null);
  const endpoint = channelId
    ? `/api/opportunities?channel=${channelId}${isNews ? `&surface=market&view=${opportunityView}` : ""}`
    : null;

  const handleChannelChange = (nextChannelId: number) => {
    const params = new URLSearchParams(searchString);
    params.set("channel", String(nextChannelId));
    params.delete("opportunity");
    setItems([]);
    setContext(null);
    setSelectedId(null);
    setStatus("loading");
    setOperationError(undefined);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const load = useCallback(async (signal?: AbortSignal) => {
    setOperationError(undefined);
    if (!store.realReady) return;
    if (!endpoint) {
      setItems([]);
      setSelectedId(null);
      setStatus("no_channel");
      return;
    }
    try {
      const response = await fetch(endpoint, { cache: "no-store", signal });
      const body = await response.json().catch(() => null) as { opportunities?: OpportunitySnapshot[]; context?: OpportunityMapContext; error?: string } | null;
      if (!response.ok || !Array.isArray(body?.opportunities) || body.opportunities.some((item) => item.channelId !== channelId)) {
        setItems([]);
        setSelectedId(null);
        setStatus(classifyOpportunityFailure(response.status, body?.error));
        return;
      }
      setItems(body.opportunities);
      setContext(body.context ?? null);
      setSelectedId((current) => current && body.opportunities!.some((item) => item.id === current) ? current : body.opportunities![0]?.id ?? null);
      setStatus("ready");
    } catch {
      if (signal?.aborted) return;
      setItems([]);
      setSelectedId(null);
      setStatus("initial_error");
    }
  }, [channelId, endpoint, fetch, store.realReady]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);
  const filteredItems = useMemo(() => filter === "all" ? items : items.filter((item) => item.opportunityType === filter), [filter, items]);
  const selected = useMemo(() => filteredItems.find((item) => item.id === selectedId) ?? filteredItems[0] ?? null, [filteredItems, selectedId]);

  const refresh = async () => {
    if (!endpoint) return;
    setRefreshing(true);
    setOperationError(undefined);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      const body = await response.json().catch(() => null) as { opportunities?: OpportunitySnapshot[]; context?: OpportunityMapContext; error?: string } | null;
      if (!response.ok || !Array.isArray(body?.opportunities) || body.opportunities.some((item) => item.channelId !== channelId)) {
        const failure = classifyOpportunityFailure(response.status, body?.error);
        if (failure === "initial_error" && items.length > 0) {
          setOperationError("Не удалось обновить карту. Показаны ранее загруженные данные.");
        } else {
          setItems([]);
          setSelectedId(null);
          setStatus(failure);
        }
        return;
      }
      setItems(body.opportunities);
      setContext(body.context ?? null);
      setSelectedId(body.opportunities[0]?.id ?? null);
      setStatus("ready");
    } catch {
      if (items.length > 0) {
        setOperationError("Не удалось обновить карту. Показаны ранее загруженные данные.");
      } else setStatus("initial_error");
    } finally {
      setRefreshing(false);
    }
  };
  const setItemState = async (item: OpportunitySnapshot, nextState: "saved" | "not_relevant") => {
    setMutatingId(item.id);
    setOperationError(undefined);
    try {
      const response = await fetch(`/api/opportunities/${item.id}/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: nextState }),
      });
      if (!response.ok) throw new Error("state_failed");
      if (nextState === "not_relevant") {
        setDismissedItem(item);
        setItems((current) => current.filter((candidate) => candidate.id !== item.id));
        setSelectedId((current) => current === item.id ? null : current);
        setFilter("all");
      } else {
        setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, userState: "saved" } : candidate));
      }
    } catch {
      setOperationError("Не удалось сохранить выбор. Повторите попытку.");
    } finally {
      setMutatingId(null);
    }
  };
  const undoDismiss = async () => {
    if (!dismissedItem) return;
    const item = dismissedItem;
    setMutatingId(item.id);
    setOperationError(undefined);
    try {
      const response = await fetch(`/api/opportunities/${item.id}/state`, { method: "DELETE" });
      if (!response.ok) throw new Error("undo_failed");
      setItems((current) => [...current, { ...item, userState: null }]
        .sort((left, right) => right.priorityScore - left.priorityScore));
      setSelectedId(item.id);
      setDismissedItem(null);
    } catch {
      setOperationError("Не удалось вернуть возможность. Повторите попытку.");
    } finally {
      setMutatingId(null);
    }
  };
  const restoreHidden = async (item: OpportunitySnapshot) => {
    setMutatingId(item.id);
    setOperationError(undefined);
    try {
      const response = await fetch(`/api/opportunities/${item.id}/state`, { method: "DELETE" });
      if (!response.ok) throw new Error("restore_failed");
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      setSelectedId((current) => current === item.id ? null : current);
    } catch {
      setOperationError("Не удалось вернуть инфоповод. Повторите попытку.");
    } finally {
      setMutatingId(null);
    }
  };
  const create = async (item: OpportunitySnapshot) => {
    if (item.growthMoveId) {
      router.push(opportunityStudioHref({
        growthMoveId: item.growthMoveId,
        opportunityId: item.id,
        channelId: item.channelId,
      }));
      return;
    }
    if (item.actionHref) { router.push(item.actionHref); return; }
    setCreatingId(item.id);
    setOperationError(undefined);
    try {
      const response = await fetch(`/api/opportunities/${item.id}/draft`, { method: "POST" });
      const body = await response.json().catch(() => null) as { draftId?: number; error?: string } | null;
      if (!response.ok || !body?.draftId) {
        setOperationError(opportunityActionError(body?.error));
        return;
      }
      router.push(`/app/studio?draft=${body.draftId}&intent=create&opportunity=${item.id}`);
    } catch {
      setOperationError("Сеть недоступна. Проверьте соединение и повторите создание черновика.");
    } finally {
      setCreatingId(null);
    }
  };

  const activeChannel = tgChannels.find((item) => item.id === channelId) ?? null;
  const viewTitle = opportunityView === "saved" ? "Сохранённые инфоповоды"
    : opportunityView === "used" ? "Использованные инфоповоды"
      : opportunityView === "hidden" ? "Скрытые инфоповоды" : "Инфоповоды";

  if (isNews) {
    const copy = NEWS_VIEW_COPY[opportunityView];
    const availableFilters = (["breaking_news", "rising_topic"] as const)
      .filter((value) => items.some((item) => item.opportunityType === value));
    const sourceUrls = new Set(items.flatMap((item) => item.sources.map((source) => source.url)));
    const actionableCount = items.filter((item) => item.actionable).length;
    const savedCount = items.filter((item) => item.userState === "saved").length;
    const monitorState = context?.researchState === "researching" ? "checking" : "ready";

    return (
      <AppShell
        title="Инфоповоды"
        subtitle="Важные события для вашего канала — вы выбираете, что превратить в пост."
        stickyHeaderOnMobile={false}
      >
        <div className="space-y-8">
          {status === "loading" ? (
            <div className="space-y-6" aria-busy="true" aria-label="Загружаем инфоповоды">
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
              <span className="sr-only" role="status">Загружаем инфоповоды…</span>
            </div>
          ) : null}

          {status === "no_channel" ? (
            <Card>
              <EmptyState
                icon={<Newspaper className="h-6 w-6" />}
                title="Подключите канал для инфоповодов"
                body="Аврора будет искать события и растущие темы, подходящие именно вашей аудитории."
                action={<Link className={buttonClassName({ variant: "brand", size: "sm" })} href="/app/settings?section=channels">Подключить канал</Link>}
              />
            </Card>
          ) : null}

          {status === "feature_disabled" ? (
            <Card className="p-6">
              <H2>Инфоповоды пока не включены для этого канала</H2>
              <SecondaryText className="mt-2">Выберите другой канал или вернитесь позже.</SecondaryText>
              <ChannelPicker channels={tgChannels} value={channelId} onChange={handleChannelChange} className="mt-5" />
            </Card>
          ) : null}

          {status === "access_denied" ? (
            <Card className="bg-danger-soft p-5" role="alert">
              <p className="text-[14px] font-bold text-danger-text">Нет доступа к инфоповодам</p>
              <p className="mt-1 text-[13px] text-text-2">Попросите владельца проекта проверить вашу роль.</p>
            </Card>
          ) : null}

          {status === "session_expired" ? (
            <Card className="bg-danger-soft p-5" role="alert">
              <p className="text-[14px] font-bold text-danger-text">Сессия завершилась</p>
              <Link className={buttonClassName({ variant: "brand", size: "sm", className: "mt-4" })} href="/login">Войти снова</Link>
            </Card>
          ) : null}

          {status === "initial_error" ? (
            <Card className="flex flex-col gap-4 bg-danger-soft p-5 sm:flex-row sm:items-center sm:justify-between" role="alert">
              <div>
                <p className="text-[14px] font-bold text-danger-text">Не удалось обновить инфоповоды</p>
                <p className="mt-1 text-[13px] text-text-2">Проверьте соединение и повторите загрузку.</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => { setStatus("loading"); void load(); }}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                Повторить
              </Button>
            </Card>
          ) : null}

          {status === "ready" ? (
            <>
              {operationError ? (
                <Card className="flex flex-col gap-4 bg-danger-soft p-5 sm:flex-row sm:items-center sm:justify-between" role="alert">
                  <p className="text-[13px] text-text-2">{operationError}</p>
                  <Button variant="outline" size="sm" onClick={() => setOperationError(undefined)}>Закрыть</Button>
                </Card>
              ) : null}
              {dismissedItem ? (
                <Card className="flex flex-wrap items-center justify-between gap-3 p-4" role="status">
                  <p className="text-[14px] text-text-2">Инфоповод скрыт из подборки.</p>
                  <Button variant="secondary" size="sm" loading={mutatingId === dismissedItem.id} onClick={() => void undoDismiss()}>Отменить</Button>
                </Card>
              ) : null}

              <Card as="section" data-ui="opportunity-monitoring-compact" className="overflow-hidden" aria-labelledby="automation-title">
                <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]">
                  <div className="min-w-0 p-5 sm:p-6">
                    <div className="flex items-start gap-3.5">
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-sm bg-info-soft text-brand" aria-hidden>
                        <Sparkles className="h-5 w-5" strokeWidth={2} />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2.5">
                          <H2 id="automation-title">Мониторинг инфоповодов</H2>
                          <Badge tone={monitorState === "checking" ? "fire" : "success"}>
                            {monitorState === "checking" ? <RefreshCw className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
                            {monitorState === "checking" ? "Проверяем" : "Работает"}
                          </Badge>
                        </div>
                        <SecondaryText className="mt-1.5 max-w-3xl text-pretty">
                          Аврора ищет свежие события и растущие темы по профилю канала, убирает повторы и ничего не публикует без вашего решения.
                        </SecondaryText>
                      </div>
                    </div>

                    <div role="status" aria-live="polite" className="nums mt-4 flex min-h-6 flex-wrap items-center gap-x-4 gap-y-2 text-text-3">
                      <Caption as="span" className="inline-flex items-center gap-1.5 font-semibold">
                        <Newspaper className="h-3.5 w-3.5 text-brand" aria-hidden />
                        {sourceUrls.size} {plural(sourceUrls.size, "источник учтён", "источника учтены", "источников учтены")}
                      </Caption>
                      <Caption as="span" className="inline-flex items-center gap-1.5 font-semibold">
                        <Bookmark className="h-3.5 w-3.5 text-brand" aria-hidden />
                        {items.length} {plural(items.length, "инфоповод", "инфоповода", "инфоповодов")} в этом разделе
                      </Caption>
                      {savedCount > 0 ? (
                        <Caption as="span" className="inline-flex items-center gap-1.5 font-semibold">
                          <BookmarkCheck className="h-3.5 w-3.5 text-brand" aria-hidden />
                          Сохранено: {savedCount}
                        </Caption>
                      ) : null}
                    </div>

                    <dl className="mt-4 grid gap-3 sm:grid-cols-3">
                      <div className="rounded-sm border border-line bg-surface px-4 py-3.5">
                        <dt className="type-caption font-semibold text-text-3">В подборке</dt>
                        <dd className="nums mt-1.5 type-h3 text-text">{items.length}</dd>
                      </div>
                      <div className="rounded-sm border border-line bg-surface px-4 py-3.5">
                        <dt className="type-caption font-semibold text-text-3">Можно использовать</dt>
                        <dd className="nums mt-1.5 type-h3 text-text">{actionableCount}</dd>
                      </div>
                      <div className="rounded-sm border border-line bg-surface px-4 py-3.5">
                        <dt className="type-caption font-semibold text-text-3">Последняя проверка</dt>
                        <dd className="nums mt-2 type-body-strong text-text">{context?.lastRefreshAt ? fmtAgo(context.lastRefreshAt) : "Запускается"}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="border-t border-line bg-surface-inset/45 p-4 sm:p-5 lg:border-t-0 lg:border-l">
                    <div className="rounded-md border border-line bg-surface p-4">
                      {tgChannels.length > 1 ? (
                        <label className="flex min-w-0 flex-col gap-1.5 type-label text-text-2">
                          Канал для подборки
                          <select
                            value={channelId ?? ""}
                            onChange={(event) => handleChannelChange(Number(event.target.value))}
                            className="h-11 w-full rounded-xs border border-line bg-surface px-3 text-base text-text transition-colors duration-150 hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 motion-reduce:transition-none sm:text-[14px]"
                          >
                            {tgChannels.map((channel) => <option key={channel.id} value={channel.id}>{channelName(channel)}</option>)}
                          </select>
                        </label>
                      ) : (
                        <div>
                          <Caption className="font-semibold text-text-3">Канал для подборки</Caption>
                          <p className="mt-1.5 flex min-h-11 items-center rounded-xs border border-line bg-surface px-3 type-body-strong text-text">{activeChannel ? channelName(activeChannel) : "Канал не выбран"}</p>
                        </div>
                      )}
                      <Link href="/app/settings?section=content" className="type-caption mt-1.5 inline-flex min-h-11 items-center gap-1.5 font-semibold text-brand underline-offset-4 hover:underline focus-visible:rounded-xs focus-visible:ring-4 focus-visible:ring-brand/15">
                        Настроить профиль контента
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                      <div className="mt-2 border-t border-line pt-4">
                        <Button variant="brand" className="w-full" loading={refreshing} onClick={() => void refresh()}>
                          <RefreshCw className="h-4 w-4" aria-hidden />
                          Найти свежие
                        </Button>
                        <Caption className="mt-2.5 text-pretty text-text-3">В Студию перейдёт только тот инфоповод, который вы выберете.</Caption>
                      </div>
                    </div>
                  </div>
                </div>
              </Card>

              <section aria-labelledby="opportunities-title" className="min-w-0 space-y-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                  <div className="min-w-0">
                    <H2 id="opportunities-title">{copy.title}</H2>
                    <SecondaryText className="mt-1.5 max-w-2xl text-pretty text-text-3">{copy.body}</SecondaryText>
                  </div>
                  {availableFilters.length > 1 ? (
                    <label className="flex min-w-0 flex-col gap-1.5 text-[12px] font-bold text-text sm:min-w-52">
                      Тип инфоповода
                      <select
                        value={filter}
                        onChange={(event) => setFilter(event.target.value as OpportunityFilter)}
                        className="h-11 rounded-xs border border-line bg-surface px-3 text-base font-semibold text-text focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-[14px]"
                      >
                        <option value="all">Все типы</option>
                        {availableFilters.map((value) => <option key={value} value={value}>{opportunityTypeLabel[value]}</option>)}
                      </select>
                    </label>
                  ) : null}
                </div>

                {items.length === 0 ? (
                  <Card>
                    <EmptyState
                      icon={opportunityView === "saved" ? <Bookmark className="h-6 w-6" /> : opportunityView === "used" ? <CalendarCheck2 className="h-6 w-6" /> : opportunityView === "hidden" ? <EyeOff className="h-6 w-6" /> : <Newspaper className="h-6 w-6" />}
                      title={context?.researchState === "profile_required"
                        ? "Уточните тему канала"
                        : opportunityView === "saved" ? "Сохранённых инфоповодов пока нет"
                          : opportunityView === "used" ? "Здесь появятся использованные материалы"
                            : opportunityView === "hidden" ? "Скрытых инфоповодов нет"
                              : "Аврора уже ищет первые инфоповоды"}
                      body={context?.researchState === "profile_required"
                        ? "Укажите нишу, аудиторию и стоп-темы, чтобы Аврора находила подходящие события."
                        : opportunityView === "active"
                          ? "Новых достаточно сильных событий пока нет. Аврора продолжит проверку."
                          : "Инфоповоды появятся здесь после соответствующего действия в основной подборке."}
                      action={context?.researchState === "profile_required" ? (
                        <Link className={buttonClassName({ variant: "brand", size: "sm" })} href="/app/settings?section=content">Заполнить профиль канала</Link>
                      ) : opportunityView !== "active" ? (
                        <Button variant="brand" size="sm" onClick={() => router.push(channelId ? `/app/rss?channel=${channelId}` : "/app/rss")}>Открыть подборку</Button>
                      ) : undefined}
                    />
                  </Card>
                ) : filteredItems.length === 0 ? (
                  <Card>
                    <EmptyState
                      icon={<Newspaper className="h-6 w-6" />}
                      title="Нет инфоповодов этого типа"
                      body="Выберите другой тип или вернитесь ко всей подборке."
                      action={<Button variant="brand" size="sm" onClick={() => setFilter("all")}>Показать все</Button>}
                    />
                  </Card>
                ) : (
                  <div className="space-y-4">
                    {filteredItems.map((item) => (
                      <NewsOpportunityCard
                        key={item.id}
                        item={item}
                        view={opportunityView}
                        creating={creatingId === item.id}
                        mutating={mutatingId === item.id}
                        onCreate={(candidate) => void create(candidate)}
                        onState={(candidate, nextState) => void setItemState(candidate, nextState)}
                        onRestore={(candidate) => void restoreHidden(candidate)}
                      />
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : null}
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      title={isNews ? viewTitle : "Карта возможностей"}
      subtitle={isNews
        ? `Свежие события и растущие темы для ${activeChannel ? channelName(activeChannel) : "выбранного канала"}.`
        : "Свежие темы, где у канала есть место для собственного голоса."}
      action={status === "ready" ? (
        <Button data-aurora-feature="map" data-aurora-action="built" onClick={() => void refresh()} loading={refreshing}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          {isNews ? "Найти свежие" : "Обновить карту"}
        </Button>
      ) : undefined}
    >
      <div className="mx-auto w-full max-w-[76rem] space-y-5">
        {status === "loading" && (
          <Card className="min-h-64 p-6" role="status" aria-busy="true">
            <div className="skeleton h-7 w-56 rounded-xs" />
            <div className="mt-5 grid gap-4 lg:grid-cols-2"><div className="skeleton h-52 rounded-md" /><div className="skeleton h-52 rounded-md" /></div>
            <span className="sr-only">Загружаем возможности выбранного канала</span>
          </Card>
        )}
        {status === "no_channel" && (
          <Card className="p-6"><h2>Подключите канал</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">Аврора построит карту возможностей после подключения активного канала.</p><Link className={buttonClassName({ variant: "primary", className: "mt-5" })} href="/app/settings?section=channels">Подключить канал</Link></Card>
        )}
        {status === "feature_disabled" && (
          <Card className="p-6"><h2>Карта пока не включена для этого канала</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">Выберите другой канал или вернитесь позже.</p><ChannelPicker channels={tgChannels} value={channelId} onChange={handleChannelChange} className="mt-5" /></Card>
        )}
        {status === "access_denied" && <Card className="border-danger/30 p-6" role="alert"><h2>Нет доступа к карте</h2><p className="mt-2 max-w-[65ch] text-[15px] leading-relaxed text-text-2">Попросите владельца проекта проверить вашу роль.</p><Link className={buttonClassName({ className: "mt-4" })} href="/app/calendar">Вернуться в календарь</Link></Card>}
        {status === "session_expired" && <Card className="border-danger/30 p-6" role="alert"><h2>Сессия завершилась</h2><p className="mt-2 text-[15px] text-text-2">Войдите снова, чтобы открыть карту возможностей.</p><Link className={buttonClassName({ variant: "primary", className: "mt-4" })} href="/login">Войти снова</Link></Card>}
        {status === "initial_error" && <Card className="border-danger/30 p-6" role="alert"><h2>Не удалось загрузить карту</h2><p className="mt-2 text-[15px] text-text-2">Проверьте соединение и повторите загрузку.</p><Button variant="primary" className="mt-4" onClick={() => { setStatus("loading"); void load(); }}>Повторить загрузку</Button></Card>}
        {status === "ready" && operationError && <Card className="border-danger/30 p-4" role="alert"><p className="text-[14px] leading-relaxed text-text-2">{operationError}</p><Button variant="ghost" size="sm" className="mt-2" onClick={() => setOperationError(undefined)}>Закрыть сообщение</Button></Card>}
        {status === "ready" && dismissedItem && <Card className="flex flex-wrap items-center justify-between gap-3 p-4" role="status"><p className="text-[14px] leading-relaxed text-text-2">Возможность скрыта как неподходящая.</p><Button variant="secondary" size="sm" loading={mutatingId === dismissedItem.id} onClick={() => void undoDismiss()}>Отменить</Button></Card>}

        {status === "ready" && (
          <Card className="p-4 sm:p-5">
            <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
              <div className="min-w-0">
                {tgChannels.length > 1 ? (
                  <ChannelPicker channels={tgChannels} value={channelId} onChange={handleChannelChange} />
                ) : activeChannel ? (
                  <><p className="type-caption text-text-3">Канал</p><p className="mt-1 font-semibold text-text">{channelName(activeChannel)}</p></>
                ) : null}
                <p className="mt-3 text-[14px] text-text-2" role="status">
                  {isNews
                    ? `${items.length} ${items.length === 1 ? "инфоповод" : items.length >= 2 && items.length <= 4 ? "инфоповода" : "инфоповодов"} для этого канала`
                    : opportunityCountLabel(items.length)}
                </p>
              </div>
              {!isNews && items.length > 0 && (
                <div className="hidden shrink-0 rounded-sm bg-surface-inset p-1 md:inline-flex" role="group" aria-label="Представление карты">
                  <Button variant={view === "list" ? "secondary" : "ghost"} size="sm" aria-pressed={view === "list"} onClick={() => setView("list")}><List className="h-4 w-4" aria-hidden />Список</Button>
                  <Button variant={view === "map" ? "secondary" : "ghost"} size="sm" aria-pressed={view === "map"} onClick={() => setView("map")}><Grid2X2 className="h-4 w-4" aria-hidden />Матрица</Button>
                </div>
              )}
            </div>
          </Card>
        )}

        {status === "ready" && items.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Фильтр возможностей">
            {(isNews
              ? (["all", "breaking_news", "rising_topic"] as OpportunityFilter[])
              : (["all", "breaking_news", "rising_topic", "evergreen_gap", "competitor_gap", "audience_need", "offer_gap"] as OpportunityFilter[])
            ).map((value) => {
              const count = value === "all" ? items.length : items.filter((item) => item.opportunityType === value).length;
              if (value !== "all" && count === 0) return null;
              return <Button key={value} size="sm" className="shrink-0" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "all" ? "Все" : opportunityTypeLabel[value]} · {count}</Button>;
            })}
          </div>
        )}

        {status === "ready" && items.length === 0 && (
          context?.researchState === "profile_required" ? (
            <Card className="p-6"><h2>Уточните тему канала</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">{isNews ? "Аврора возьмёт из профиля нишу, аудиторию и стоп-темы, чтобы самостоятельно найти подходящие источники и события." : "Авроре достаточно ниши и одной рубрики, чтобы построить стартовую карту без конкурентов и истории публикаций."}</p><Link className={buttonClassName({ variant: "primary", className: "mt-5" })} href="/app/settings?section=content">Заполнить профиль канала</Link></Card>
          ) : (
            <Card className="p-6"><h2>{isNews ? "Аврора ищет первые инфоповоды" : "Аврора собирает первые сигналы"}</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">{isNews ? "Профиль канала готов. Аврора проверит открытые источники, уберёт повторы и оставит только то, что подходит тематике и аудитории." : "Профиль готов. Запустите обновление: Аврора проверит открытую базу и создаст стартовые темы, даже если канал новый."}</p><Button variant="primary" className="mt-5" onClick={() => void refresh()} loading={refreshing}><RefreshCw className="h-4 w-4" aria-hidden />{isNews ? "Найти инфоповоды" : "Собрать возможности"}</Button></Card>
          )
        )}

        {status === "ready" && !isNews && filteredItems.length > 0 && view === "map" && (
          <div className="hidden gap-5 md:grid lg:grid-cols-[minmax(0,1fr)_minmax(24rem,1fr)]">
            <section aria-labelledby="opportunity-map-title">
              <Card className="p-5 sm:p-6"><h2 id="opportunity-map-title">Спрос и покрытие канала</h2><p className="mt-2 text-pretty text-[14px] leading-relaxed text-text-2">Выше — спрос сильнее. Правее — тема уже чаще встречалась в выбранном канале.</p><div className="relative mt-6 h-80 rounded-sm bg-surface-inset p-6" role="group" aria-label="Матрица возможностей"><span className="absolute bottom-2 left-1/2 -translate-x-1/2 type-caption text-text-3">Покрытие канала →</span><span className="absolute left-2 top-1/2 -rotate-90 type-caption text-text-3">Спрос →</span>{filteredItems.map((item, index) => <button key={item.id} type="button" aria-label={`${item.title}. Спрос ${item.demand} из 4, покрытие ${item.coverage} из 4, ${confidenceLabel[item.confidence]}`} aria-pressed={selected?.id === item.id} onClick={() => setSelectedId(item.id)} style={{ insetInlineStart: `${12 + item.coverage * 18}%`, bottom: `${12 + item.demand * 17}%`, width: `${Math.min(56, 34 + Math.max(1, item.sourceCount) * 3)}px`, height: `${Math.min(56, 34 + Math.max(1, item.sourceCount) * 3)}px` }} className={cn("absolute grid min-h-11 min-w-11 place-items-center rounded-full border-2 font-semibold tabular-nums transition-[transform,background-color,border-color] motion-reduce:transition-none", selected?.id === item.id ? "scale-110 border-brand bg-brand text-white" : "border-line-strong bg-surface text-text hover:border-brand")}>{index + 1}</button>)}</div></Card>
            </section>
            {selected && <aside aria-labelledby="opportunity-map-detail-title" className="self-start lg:sticky lg:top-6"><OpportunityDetails item={selected} creating={creatingId === selected.id} mutating={mutatingId === selected.id} onState={(item, state) => void setItemState(item, state)} onCreate={(item) => void create(item)} titleId="opportunity-map-detail-title" /></aside>}
          </div>
        )}

        {status === "ready" && filteredItems.length > 0 && (
          <div className={cn("grid items-start gap-5 lg:grid-cols-[minmax(18rem,0.95fr)_minmax(24rem,1.05fr)]", !isNews && view === "map" && "md:hidden")}>
            <section aria-labelledby="opportunity-list-title">
              <h2 id="opportunity-list-title" className="sr-only">Приоритетный список</h2>
              <ul className="space-y-3">
                {filteredItems.map((item, index) => {
                  const isSelected = selected?.id === item.id;
                  return (
                    <li key={item.id} className="space-y-3">
                      <button type="button" onClick={() => setSelectedId(item.id)} aria-pressed={isSelected} className={cn("w-full rounded-md bg-surface/75 p-4 text-start shadow-soft transition-[background-color,box-shadow,transform] motion-reduce:transition-none active:scale-[0.96] sm:p-5", isSelected ? "bg-surface ring-2 ring-brand" : "hover:bg-surface")}>
                        <div className="flex flex-wrap items-center gap-2"><Badge tone={index === 0 ? "brand" : "neutral"}>{index === 0 ? "Приоритет" : `№ ${index + 1}`}</Badge><Badge tone={item.confidence === "high" ? "success" : item.confidence === "medium" ? "fire" : "neutral"}>{confidenceLabel[item.confidence]}</Badge></div>
                        <h3 className="mt-3 line-clamp-3 text-balance text-[17px] leading-snug">{item.title}</h3>
                        <p className="mt-2 text-[13px] leading-relaxed text-text-2">{item.freshnessLabel} · {item.channelLabel}</p>
                        <span className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand lg:hidden">{isSelected ? "Подробности открыты" : "Развернуть подробности"}<ChevronDown className={cn("h-4 w-4 transition-transform duration-150 motion-reduce:transition-none", isSelected && "rotate-180")} aria-hidden /></span>
                      </button>
                      {isSelected && <OpportunityDetails item={item} creating={creatingId === item.id} mutating={mutatingId === item.id} onState={(candidate, state) => void setItemState(candidate, state)} onCreate={(candidate) => void create(candidate)} onRestore={(candidate) => void restoreHidden(candidate)} titleId={`opportunity-mobile-detail-title-${item.id}`} className="lg:hidden" createLabel={isNews ? "Создать пост" : undefined} view={opportunityView} />}
                    </li>
                  );
                })}
              </ul>
            </section>
            {selected && <aside aria-labelledby="opportunity-detail-title" className="hidden self-start lg:sticky lg:top-6 lg:block"><OpportunityDetails item={selected} creating={creatingId === selected.id} mutating={mutatingId === selected.id} onState={(item, state) => void setItemState(item, state)} onCreate={(item) => void create(item)} onRestore={(item) => void restoreHidden(item)} titleId="opportunity-detail-title" createLabel={isNews ? "Создать пост" : undefined} view={opportunityView} /></aside>}
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default function OpportunitiesPage() {
  return <OpportunityWorkspace />;
}
