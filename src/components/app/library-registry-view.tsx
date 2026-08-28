"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDownAZ,
  Bookmark,
  Check,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Filter,
  Gauge,
  Heart,
  MessageSquareText,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  X,
} from "lucide-react";

import { LibraryCardText, libraryCardContentId, toggleExpandedCardId } from "@/components/app/library-card-text";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Input } from "@/components/ui/primitives";
import { appDraftActionHref, type DraftBackedAppAction } from "@/lib/app-routes";
import { createDraftClientKey, createLibraryServerDraft, libraryDraftErrorMessage } from "@/lib/draft-client";
import type {
  LibraryFormat,
  LibraryMaturity,
  LibraryQuality,
  LibraryRegistryDiagnostics,
  LibraryRegistryItem,
  LibrarySavedFilter,
  LibrarySort,
  LibraryViewedFilter,
} from "@/lib/library-filters";
import { useStore } from "@/lib/store";
import { cn, fmtAgo, fmtNum } from "@/lib/utils";

type Filters = {
  q: string;
  source: string;
  from: string;
  to: string;
  formats: LibraryFormat[];
  saved: LibrarySavedFilter;
  viewed: LibraryViewedFilter;
  ratingMin: string;
  ratingMax: string;
  viewsMin: string;
  viewsMax: string;
  reactionsMin: string;
  reactionsMax: string;
  liftMin: string;
  liftMax: string;
  scoreMin: string;
  scoreMax: string;
  qualities: LibraryQuality[];
  maturities: LibraryMaturity[];
  sort: LibrarySort;
  direction: "asc" | "desc";
  hitOnly: boolean;
};

type RegistryResponse = {
  ok?: boolean;
  items?: LibraryRegistryItem[];
  formulaVersion?: string;
  exportedAt?: string;
  diagnostics?: LibraryRegistryDiagnostics;
  error?: string;
};

type ExportLink = { format: "csv" | "xlsx" | "json" | "pdf" | "html" | "markdown"; href: string };

const DEFAULT_FILTERS: Filters = {
  q: "",
  source: "",
  from: "",
  to: "",
  formats: [],
  saved: "all",
  viewed: "all",
  ratingMin: "",
  ratingMax: "",
  viewsMin: "",
  viewsMax: "",
  reactionsMin: "",
  reactionsMax: "",
  liftMin: "",
  liftMax: "",
  scoreMin: "",
  scoreMax: "",
  qualities: [],
  maturities: [],
  sort: "score",
  direction: "desc",
  hitOnly: false,
};

const FORMAT_LABELS: Record<LibraryFormat, string> = { text: "Текст", photo: "Фото", video: "Видео" };
const SORT_LABELS: Record<LibrarySort, string> = {
  score: "Оценка",
  freshness: "Свежесть",
  views: "Просмотры",
  reactions: "Реакции",
  lift: "Прирост",
  engagement_rate: "Доля вовлечения",
  velocity: "Скорость",
};
const EXPORT_LABELS: Record<ExportLink["format"], string> = {
  csv: "Таблица CSV",
  xlsx: "Таблица Excel",
  json: "Данные JSON",
  pdf: "Документ PDF",
  html: "Веб-страница",
  markdown: "Текстовый файл",
};
const QUALITY_LABELS: Record<string, string> = {
  low: "низкое качество",
  medium: "среднее качество",
  high: "высокое качество",
};
const MATURITY_LABELS: Record<string, string> = {
  collecting: "данные накапливаются",
  mature: "данных достаточно",
};

function finite(value: string) {
  const number = Number(value);
  return value.trim() && Number.isFinite(number) ? number : undefined;
}

function versionLabel(value: string | null | undefined) {
  const version = value?.match(/\d+(?:\.\d+)*/u)?.[0];
  return version || "текущая";
}

export function libraryRegistryEmptyState(
  diagnostics: LibraryRegistryDiagnostics | null,
  activeFilterCount: number,
) {
  if (activeFilterCount > 0 || (diagnostics?.totalItemCount ?? 0) > 0) {
    return {
      kind: "filtered" as const,
      title: "По этим условиям ничего нет",
      body: "Ослабь диапазон или сбрось фильтры. Исходные данные не удалены.",
    };
  }
  if (!diagnostics || diagnostics.competitorCount === 0) {
    return {
      kind: "competitors" as const,
      title: "Добавь конкурентов для первых примеров",
      body: "Аврора соберёт их открытые публикации, сравнит результаты внутри каждого источника и покажет подтверждённые механики.",
    };
  }
  if (diagnostics.sourcePostCount === 0) {
    return {
      kind: "collecting" as const,
      title: "Собираем первые публикации",
      body: "Конкуренты подключены, но их материалы ещё не появились. Обычно они приходят после ближайшего прохода разведки.",
    };
  }
  return {
    kind: "waiting" as const,
    title: "Готовых материалов пока нет",
    body: diagnostics.pendingIdeaCount > 0
      ? `ИИ ещё готовит ${diagnostics.pendingIdeaCount} ${diagnostics.pendingIdeaCount === 1 ? "идею" : "идеи"}. Референсы появятся после завершения сбора.`
      : "Разведка уже видит публикации, но пока не нашла материалов с достаточными данными для этого реестра.",
  };
}

export function libraryFilterPayload(channelId: number, filters: Filters) {
  return {
    channel: channelId,
    q: filters.q.trim() || undefined,
    source: filters.source ? [filters.source] : [],
    from: filters.from || undefined,
    to: filters.to || undefined,
    format: filters.formats,
    saved: filters.saved,
    viewed: filters.viewed,
    ratingMin: finite(filters.ratingMin),
    ratingMax: finite(filters.ratingMax),
    viewsMin: finite(filters.viewsMin),
    viewsMax: finite(filters.viewsMax),
    reactionsMin: finite(filters.reactionsMin),
    reactionsMax: finite(filters.reactionsMax),
    liftMin: finite(filters.liftMin),
    liftMax: finite(filters.liftMax),
    scoreMin: finite(filters.scoreMin),
    scoreMax: finite(filters.scoreMax),
    quality: filters.qualities,
    maturity: filters.maturities,
    sort: filters.sort,
    direction: filters.direction,
    hit: filters.hitOnly ? "only" : "all",
    limit: 500,
  };
}

export function libraryRegistryQuery(channelId: number, filters: Filters) {
  const payload = libraryFilterPayload(channelId, filters);
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(payload)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) if (value !== undefined && value !== "") params.append(key, String(value));
  }
  return params;
}

function toggleValue<T extends string>(values: T[], value: T) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function metric(value: number | null, digits = 1) {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function itemIdentity(item: LibraryRegistryItem) {
  const [kind, id] = item.id.split(":");
  const numericId = Number(id);
  return {
    kind: (kind === "reference" || kind === "idea" || kind === "saved" ? kind : null) as "reference" | "idea" | "saved" | null,
    id: Number.isSafeInteger(numericId) && numericId > 0 ? numericId : null,
  };
}

function NumberRange({
  label,
  min,
  max,
  minLabel = "От",
  maxLabel = "До",
  onMin,
  onMax,
}: {
  label: string;
  min: string;
  max: string;
  minLabel?: string;
  maxLabel?: string;
  onMin: (value: string) => void;
  onMax: (value: string) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-[12px] font-bold text-text-2">{label}</legend>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <Input className="min-w-0" type="number" min={0} value={min} onChange={(event) => onMin(event.target.value)} placeholder={minLabel} aria-label={`${label}: ${minLabel.toLowerCase()}`} />
        <Input className="min-w-0" type="number" min={0} value={max} onChange={(event) => onMax(event.target.value)} placeholder={maxLabel} aria-label={`${label}: ${maxLabel.toLowerCase()}`} />
      </div>
    </fieldset>
  );
}

export function LibraryRegistryView({ channelId, channelName }: { channelId: number; channelName: string }) {
  const router = useRouter();
  const store = useStore();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [items, setItems] = useState<LibraryRegistryItem[]>([]);
  const [sourceOptions, setSourceOptions] = useState<Array<{ id: string; title: string }>>([]);
  const [formulaVersion, setFormulaVersion] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<LibraryRegistryDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [stateBusy, setStateBusy] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportLinks, setExportLinks] = useState<ExportLink[]>([]);
  const [exportCount, setExportCount] = useState<number | null>(null);
  const requestSequence = useRef(0);
  const draftKeys = useRef(new Map<string, string>());
  const exportKey = useRef<string | null>(null);

  const load = useCallback(async (active: Filters) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/library/registry?${libraryRegistryQuery(channelId, active)}`, { cache: "no-store" });
      const body = await response.json() as RegistryResponse;
      if (!response.ok || !body.ok || !Array.isArray(body.items)) throw new Error(body.error || "registry_failed");
      if (sequence !== requestSequence.current) return;
      setItems(body.items);
      setFormulaVersion(body.formulaVersion || null);
      setDiagnostics(body.diagnostics ?? null);
      setSourceOptions((current) => {
        const options = new Map(current.map((item) => [item.id, item.title]));
        for (const item of body.items || []) {
          if (item.sourceId) options.set(item.sourceId, item.sourceTitle);
        }
        return [...options].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title, "ru"));
      });
      setError(false);
    } catch {
      if (sequence === requestSequence.current) setError(true);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(filters), 250);
    return () => window.clearTimeout(timer);
  }, [filters, load]);

  const update = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setExportLinks([]);
    setExportCount(null);
    exportKey.current = null;
  };

  const setItemState = async (item: LibraryRegistryItem, state: { rating?: number | null; viewed?: boolean }) => {
    const identity = itemIdentity(item);
    if (!identity.kind || !identity.id || stateBusy) return;
    const busyKey = `${item.id}:${state.rating ?? "view"}:${state.viewed ?? "same"}`;
    setStateBusy(busyKey);
    try {
      const response = await fetch("/api/library/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId,
          itemType: identity.kind,
          itemId: identity.id,
          rating: state.rating === undefined ? item.userRating : state.rating,
          viewed: state.viewed === undefined ? Boolean(item.viewedAt) : state.viewed,
        }),
      });
      if (!response.ok) throw new Error("state_failed");
      setItems((current) => current.map((candidate) => candidate.id === item.id
        ? {
            ...candidate,
            ...(state.rating !== undefined ? { userRating: state.rating } : {}),
            ...(state.viewed !== undefined ? { viewedAt: state.viewed ? (candidate.viewedAt || new Date().toISOString()) : null } : {}),
          }
        : candidate));
    } catch {
      store.toast({ kind: "danger", title: "Оценка не сохранена", body: "Данные карточки не изменены." });
    } finally {
      setStateBusy(null);
    }
  };

  const toggleCard = (item: LibraryRegistryItem) => {
    setExpanded((current) => toggleExpandedCardId(current, item.id));
    if (!item.viewedAt) void setItemState(item, { viewed: true });
  };

  const saveReference = async (item: LibraryRegistryItem) => {
    const identity = itemIdentity(item);
    if (identity.kind !== "reference" || !identity.id || stateBusy) return;
    setStateBusy(`save:${item.id}`);
    try {
      const response = await fetch("/api/library/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, kind: "reference", sourcePostId: identity.id }),
      });
      if (!response.ok) throw new Error("save_failed");
      setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, saved: true } : candidate));
      store.toast({ kind: "success", title: "Референс сохранён", body: `Добавлен в коллекцию «${channelName}».` });
    } catch {
      store.toast({ kind: "danger", title: "Не удалось сохранить референс" });
    } finally {
      setStateBusy(null);
    }
  };

  const openDraft = async (action: DraftBackedAppAction, item: LibraryRegistryItem) => {
    if (draftBusy) return;
    const key = `${action}:${item.id}:channel:${channelId}`;
    const clientKey = draftKeys.current.get(key) || createDraftClientKey();
    draftKeys.current.set(key, clientKey);
    setDraftBusy(key);
    try {
      const result = await createLibraryServerDraft({
        itemKey: item.id,
        channelId,
        clientKey,
      });
      router.push(appDraftActionHref(action, result.draft.id));
    } catch (error) {
      store.toast({
        kind: "danger",
        title: "Контекст не сохранён",
        body: libraryDraftErrorMessage(error),
      });
    } finally {
      setDraftBusy(null);
    }
  };

  const createExport = async () => {
    if (exportBusy) return;
    const key = exportKey.current || `library-export:${crypto.randomUUID()}`;
    exportKey.current = key;
    setExportBusy(true);
    try {
      const response = await fetch("/api/library/exports", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ filters: libraryFilterPayload(channelId, filters) }),
      });
      const body = await response.json() as { formats?: ExportLink[]; count?: number; error?: string };
      if (!response.ok || !Array.isArray(body.formats)) throw new Error(body.error || "export_failed");
      setExportLinks(body.formats);
      setExportCount(Number(body.count || 0));
    } catch {
      store.toast({ kind: "danger", title: "Экспорт не подготовлен", body: "Фильтры сохранены — запрос можно повторить." });
    } finally {
      setExportBusy(false);
    }
  };

  const activeFilterCount = useMemo(() => {
    const plain = [filters.q, filters.source, filters.from, filters.to, filters.ratingMin, filters.ratingMax,
      filters.viewsMin, filters.viewsMax, filters.reactionsMin, filters.reactionsMax,
      filters.liftMin, filters.liftMax, filters.scoreMin, filters.scoreMax].filter(Boolean).length;
    return plain + filters.formats.length + filters.qualities.length + filters.maturities.length
      + (filters.saved !== "all" ? 1 : 0) + (filters.viewed !== "all" ? 1 : 0) + (filters.hitOnly ? 1 : 0);
  }, [filters]);
  const emptyState = libraryRegistryEmptyState(diagnostics, activeFilterCount);

  return (
    <div className="mt-5 min-w-0 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-[18px] font-extrabold text-text">Аналитический реестр</h2>
          <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-text-3">
            Сравнение идёт только внутри одного источника, формата и временного окна. Ваша оценка 1–5 не влияет на аналитическую оценку 0–100.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">Формула: {formulaVersion || "—"}</Badge>
          <Badge tone="brand">{items.length} записей</Badge>
        </div>
      </div>

      <Card className="min-w-0 overflow-hidden">
        <div className="border-b border-line px-4 py-4 sm:px-5">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-[minmax(0,1fr)_220px_190px]">
            <label className="relative min-w-0">
              <span className="sr-only">Поиск по реестру</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden />
              <Input value={filters.q} onChange={(event) => update("q", event.target.value)} placeholder="Поиск по тексту, источнику или каналу…" className="pl-9" />
            </label>
            <label className="min-w-0">
              <span className="sr-only">Источник</span>
              <select value={filters.source} onChange={(event) => update("source", event.target.value)} className="h-12 w-full rounded-xs border border-line bg-surface px-3 text-[13px] font-semibold text-text focus:border-brand focus:outline-none">
                <option value="">Все источники</option>
                {sourceOptions.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}
              </select>
            </label>
            <label className="min-w-0">
              <span className="sr-only">Сортировка</span>
              <select value={filters.sort} onChange={(event) => update("sort", event.target.value as LibrarySort)} className="h-12 w-full rounded-xs border border-line bg-surface px-3 text-[13px] font-semibold text-text focus:border-brand focus:outline-none">
                {Object.entries(SORT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>
        </div>

        <details className="group min-w-0">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13px] font-bold text-text sm:px-5">
            <Filter className="h-4 w-4 text-brand" aria-hidden />
            Все фильтры
            {activeFilterCount > 0 && <Badge tone="brand">{activeFilterCount}</Badge>}
            <ArrowDownAZ className="ml-auto h-4 w-4 text-text-3 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 border-t border-line px-4 py-5 sm:grid-cols-2 sm:px-5 xl:grid-cols-4">
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-[12px] font-bold text-text-2">Период</legend>
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                <Input className="min-w-0" type="date" value={filters.from} onChange={(event) => update("from", event.target.value)} aria-label="Период от" />
                <Input className="min-w-0" type="date" value={filters.to} onChange={(event) => update("to", event.target.value)} aria-label="Период до" />
              </div>
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-[12px] font-bold text-text-2">Формат</legend>
              <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-xs border border-line px-2">
                {(Object.keys(FORMAT_LABELS) as LibraryFormat[]).map((format) => (
                  <label key={format} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-text-2">
                    <input type="checkbox" checked={filters.formats.includes(format)} onChange={() => update("formats", toggleValue(filters.formats, format))} /> {FORMAT_LABELS[format]}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="min-w-0">
              <span className="mb-1.5 block text-[12px] font-bold text-text-2">Сохранение</span>
              <select value={filters.saved} onChange={(event) => update("saved", event.target.value as LibrarySavedFilter)} className="h-12 w-full rounded-xs border border-line bg-surface px-3 text-[13px] text-text">
                <option value="all">Все</option><option value="saved">Сохранённые</option><option value="unsaved">Несохранённые</option>
              </select>
            </label>
            <label className="min-w-0">
              <span className="mb-1.5 block text-[12px] font-bold text-text-2">Просмотр</span>
              <select value={filters.viewed} onChange={(event) => update("viewed", event.target.value as LibraryViewedFilter)} className="h-12 w-full rounded-xs border border-line bg-surface px-3 text-[13px] text-text">
                <option value="all">Новые и просмотренные</option><option value="new">Только новые</option><option value="viewed">Просмотренные</option>
              </select>
            </label>
            <NumberRange label="Ваша оценка 1–5" min={filters.ratingMin} max={filters.ratingMax} onMin={(value) => update("ratingMin", value)} onMax={(value) => update("ratingMax", value)} />
            <NumberRange label="Просмотры" min={filters.viewsMin} max={filters.viewsMax} onMin={(value) => update("viewsMin", value)} onMax={(value) => update("viewsMax", value)} />
            <NumberRange label="Реакции" min={filters.reactionsMin} max={filters.reactionsMax} onMin={(value) => update("reactionsMin", value)} onMax={(value) => update("reactionsMax", value)} />
            <NumberRange label="Прирост" min={filters.liftMin} max={filters.liftMax} onMin={(value) => update("liftMin", value)} onMax={(value) => update("liftMax", value)} />
            <NumberRange label="Аналитическая оценка 0–100" min={filters.scoreMin} max={filters.scoreMax} onMin={(value) => update("scoreMin", value)} onMax={(value) => update("scoreMax", value)} />
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-[12px] font-bold text-text-2">Качество данных</legend>
              <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-xs border border-line px-2">
                {(["low", "medium", "high"] as LibraryQuality[]).map((quality) => (
                  <label key={quality} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-text-2">
                    <input type="checkbox" checked={filters.qualities.includes(quality)} onChange={() => update("qualities", toggleValue(filters.qualities, quality))} />
                    {quality === "high" ? "Высокое" : quality === "medium" ? "Среднее" : "Низкое"}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-[12px] font-bold text-text-2">Зрелость данных</legend>
              <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-xs border border-line px-2">
                {(["collecting", "mature"] as LibraryMaturity[]).map((maturity) => (
                  <label key={maturity} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-text-2">
                    <input type="checkbox" checked={filters.maturities.includes(maturity)} onChange={() => update("maturities", toggleValue(filters.maturities, maturity))} />
                    {maturity === "mature" ? "Зрелые" : "Накапливаются"}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex min-h-12 cursor-pointer items-center gap-2 rounded-xs border border-line px-3 text-[13px] font-semibold text-text-2">
              <input type="checkbox" checked={filters.hitOnly} onChange={(event) => update("hitOnly", event.target.checked)} />
              Только хиты: лучшие 10% автора и прирост ≥ 5
            </label>
            <label className="flex min-h-12 cursor-pointer items-center gap-2 rounded-xs border border-line px-3 text-[13px] font-semibold text-text-2">
              <input type="checkbox" checked={filters.direction === "asc"} onChange={(event) => update("direction", event.target.checked ? "asc" : "desc")} />
              Сначала меньшие значения
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-4 sm:px-5">
            <Button type="button" variant="ghost" size="sm" onClick={() => setFilters(DEFAULT_FILTERS)} disabled={!activeFilterCount}>
              <X className="h-4 w-4" aria-hidden /> Сбросить фильтры
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void createExport()} loading={exportBusy}>
              <Download className="h-4 w-4" aria-hidden /> Экспорт текущего среза
            </Button>
          </div>
          {exportLinks.length > 0 && (
            <div className="border-t border-line bg-success-soft px-4 py-4 sm:px-5" role="status">
              <p className="text-[12px] font-bold text-success-text">Один срез данных · {exportCount} записей · 6 форматов</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {exportLinks.map((link) => (
                  <a key={link.format} href={link.href} download className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-success/25 bg-surface px-3 py-2 text-[12px] font-bold text-success-text hover:border-success/50">
                    <Download className="h-3.5 w-3.5" aria-hidden /> {EXPORT_LABELS[link.format]}
                  </a>
                ))}
              </div>
            </div>
          )}
        </details>
      </Card>

      {diagnostics && diagnostics.pendingIdeaCount > 0 && (
        <Card className="border-brand/20 bg-brand-soft p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Sparkles className="h-5 w-5 shrink-0 text-brand" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-extrabold text-text">Диагностика ИИ</p>
              <p className="mt-1 text-[12px] leading-relaxed text-text-2">
                {diagnostics.pendingIdeaCount} {diagnostics.pendingIdeaCount === 1 ? "идея ожидает" : "идеи ожидают"} завершения в «{diagnostics.aiEngineLabel}».
                {diagnostics.aiConfigured
                  ? " Если число не уменьшается после следующего прохода разведки, проверь доступность выбранного ИИ."
                  : " Выбранный ИИ не подключён — идеи не смогут завершиться."}
              </p>
            </div>
            <Link href="/app/settings">
              <Button variant="outline" size="sm">Проверить ИИ</Button>
            </Link>
          </div>
        </Card>
      )}

      {error ? (
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="min-w-0 flex-1 text-[13px] text-text">Не удалось загрузить аналитический реестр.</p>
            <Button variant="outline" size="sm" onClick={() => void load(filters)}><RefreshCw className="h-4 w-4" aria-hidden /> Повторить</Button>
          </div>
        </Card>
      ) : loading ? (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2" role="status" aria-busy="true">
          <span className="sr-only">Применяем фильтры</span>
          {[0, 1, 2, 3].map((item) => <div key={item} className="skeleton h-72 rounded-md" />)}
        </div>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={emptyState.kind === "competitors" ? <Search className="h-6 w-6" /> : <Filter className="h-6 w-6" />}
            title={emptyState.title}
            body={emptyState.body}
            action={emptyState.kind === "filtered"
              ? <Button variant="outline" size="sm" onClick={() => setFilters(DEFAULT_FILTERS)}>Сбросить фильтры</Button>
              : (
                <Link href={`/app/competitors?channel=${channelId}`}>
                  <Button variant="solid" size="sm">Добавить конкурентов</Button>
                </Link>
              )}
          />
        </Card>
      ) : (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
          {items.map((item) => {
            const isExpanded = expanded.has(item.id);
            const primaryAction: DraftBackedAppAction = item.kind === "saved" ? "editor" : "create";
            const primaryKey = `${primaryAction}:${item.id}:channel:${channelId}`;
            const discussKey = `discuss:${item.id}:channel:${channelId}`;
            return (
              <Card key={item.id} className="min-w-0 flex flex-col p-4 transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-soft">
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <Badge tone={item.kind === "reference" ? "fire" : item.kind === "idea" ? "brand" : "neutral"}>
                    {item.kind === "reference" ? "Референс" : item.kind === "idea" ? "Идея" : "Коллекция"}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-bold text-text-2">{item.sourceTitle}</span>
                  <span className="text-text-3">{fmtAgo(item.postedAt)}</span>
                  {!item.viewedAt && <Badge tone="brand">Новое</Badge>}
                  {item.isHit && <Badge tone="fire">Лучшие 10% · прирост ≥ 5</Badge>}
                </div>

                <LibraryCardText
                  className="mt-3"
                  contentId={libraryCardContentId("registry", item.id)}
                  text={item.text}
                  expanded={isExpanded}
                  onToggle={() => toggleCard(item)}
                />

                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
                  <div className="rounded-xs bg-surface-inset p-2.5"><p className="text-[10px] text-text-3">Оценка 0–100</p><p className="nums mt-0.5 text-[15px] font-black text-text">{metric(item.analyticsScore, 1)}</p></div>
                  <div className="rounded-xs bg-surface-inset p-2.5"><p className="text-[10px] text-text-3">Прирост</p><p className="nums mt-0.5 text-[15px] font-black text-text">{item.lift == null ? "—" : `×${metric(item.lift, 2)}`}</p></div>
                  <div className="rounded-xs bg-surface-inset p-2.5"><p className="text-[10px] text-text-3">Скорость</p><p className="nums mt-0.5 text-[15px] font-black text-text">{metric(item.velocity, 1)}</p></div>
                  <div className="rounded-xs bg-surface-inset p-2.5"><p className="text-[10px] text-text-3">Вовлечённость</p><p className="nums mt-0.5 text-[15px] font-black text-text">{item.erBayes == null ? "—" : `${(item.erBayes * 100).toFixed(2)}%`}</p></div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-text-3">
                  {item.views != null && <span className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" aria-hidden /> {fmtNum(item.views)}</span>}
                  {item.reactions != null && <span className="flex items-center gap-1"><Heart className="h-3.5 w-3.5" aria-hidden /> {fmtNum(item.reactions)}</span>}
                  <span className="flex items-center gap-1"><Gauge className="h-3.5 w-3.5" aria-hidden /> Отклонение {metric(item.velocityZ, 2)}</span>
                  <span>{QUALITY_LABELS[item.dataQuality || ""] || "качество не определено"} · {MATURITY_LABELS[item.dataMaturity || ""] || "зрелость не определена"}</span>
                  <span>{FORMAT_LABELS[item.format]}</span>
                </div>

                <details className="mt-3 rounded-xs border border-line bg-surface-2 px-3 py-2">
                  <summary className="cursor-pointer text-[11px] font-bold text-text-2">Как рассчитана оценка</summary>
                  <p className="mt-2 text-[11px] leading-relaxed text-text-3">{item.explanation || "Недостаточно сопоставимых данных."}</p>
                  <p className="mt-1 text-[10px] text-text-3">Версия формулы: {versionLabel(item.formulaVersion || formulaVersion)}</p>
                </details>

                <fieldset className="mt-3">
                  <legend className="text-[11px] font-bold text-text-2">Ваша оценка, отдельно от аналитической</legend>
                  <div className="mt-1 flex flex-wrap items-center gap-1" aria-label="Оценка от 1 до 5">
                    {[1, 2, 3, 4, 5].map((rating) => (
                      <button
                        key={rating}
                        type="button"
                        aria-label={`Поставить оценку ${rating} из 5`}
                        aria-pressed={item.userRating === rating}
                        disabled={Boolean(stateBusy)}
                        onClick={() => void setItemState(item, { rating: item.userRating === rating ? null : rating })}
                        className="grid h-10 w-10 place-items-center rounded-sm text-text-3 hover:bg-fire-soft hover:text-fire focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 disabled:opacity-50"
                      >
                        <Star className={cn("h-4 w-4", item.userRating != null && rating <= item.userRating && "fill-current text-fire")} aria-hidden />
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={Boolean(stateBusy)}
                      onClick={() => void setItemState(item, { viewed: !item.viewedAt })}
                      className="inline-flex min-h-10 basis-full items-center gap-1.5 rounded-sm px-2 text-[11px] font-semibold text-text-2 hover:bg-surface-inset sm:ml-auto sm:basis-auto"
                    >
                      {item.viewedAt ? <EyeOff className="h-3.5 w-3.5" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}
                      {item.viewedAt ? "Сделать новым" : "Просмотрено"}
                    </button>
                  </div>
                </fieldset>

                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
                  {item.kind === "reference" && (
                    <Button variant={item.saved ? "ghost" : "solid"} size="sm" disabled={item.saved || Boolean(stateBusy)} loading={stateBusy === `save:${item.id}`} onClick={() => void saveReference(item)}>
                      {stateBusy !== `save:${item.id}` && <Bookmark className={cn("h-3.5 w-3.5", item.saved && "fill-current")} aria-hidden />}
                      {item.saved ? "Сохранено" : "Сохранить"}
                    </Button>
                  )}
                  <Button variant="soft" size="sm" loading={draftBusy === primaryKey} disabled={Boolean(draftBusy) && draftBusy !== primaryKey} onClick={() => void openDraft(primaryAction, item)}>
                    {draftBusy !== primaryKey && <Sparkles className="h-3.5 w-3.5" aria-hidden />}
                    {item.kind === "saved" ? "Открыть в редакторе" : "Создать публикацию"}
                  </Button>
                  <Button variant="ghost" size="sm" loading={draftBusy === discussKey} disabled={Boolean(draftBusy) && draftBusy !== discussKey} onClick={() => void openDraft("discuss", item)}>
                    {draftBusy !== discussKey && <MessageSquareText className="h-3.5 w-3.5" aria-hidden />}
                    Обсудить с Авророй
                  </Button>
                  {item.sourceUrl && (
                    <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-sm px-2.5 text-[12px] font-semibold text-text-2 hover:bg-surface-inset hover:text-text">
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Открыть оригинал
                    </a>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
