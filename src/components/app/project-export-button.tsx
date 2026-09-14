"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  FileDown,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";

import { useProjects } from "@/components/app/project-provider";
import { Button } from "@/components/ui/button";
import type { RealChannel } from "@/lib/types";
import {
  createProjectExport,
  defaultProjectExportPeriod,
  downloadProjectExport,
  getProjectExport,
  isActiveProjectExport,
  listProjectExports,
  parseExportAuthorOptions,
  parseExportCampaignOptions,
  previewProjectExport,
  projectExportErrorMessage,
  projectExportFormFromOperation,
  ProjectExportClientError,
  revokeProjectExport,
  validateProjectExportPeriod,
  type ClientProjectExportKind,
  type ClientProjectExportOperation,
  type ClientProjectExportPreview,
  type ExportFilterOption,
  type ProjectExportFormValue,
} from "@/lib/project-export-client";
import { cn } from "@/lib/utils";

const SELECT_CLASS = [
  "min-h-11 w-full rounded-xs border border-line bg-surface px-3 text-base text-text sm:text-[14px]",
  "transition-colors duration-150 hover:border-line-strong focus:border-brand focus:outline-none",
  "focus-visible:ring-4 focus-visible:ring-brand/15 disabled:cursor-not-allowed disabled:opacity-50",
].join(" ");

const DATE_CLASS = [
  "min-h-11 w-full rounded-xs border border-line bg-surface px-3 text-base text-text sm:text-[14px]",
  "transition-colors duration-150 hover:border-line-strong focus:border-brand focus:outline-none",
  "focus-visible:ring-4 focus-visible:ring-brand/15",
].join(" ");

const CONTENT_STATUSES = [
  ["", "Все статусы"],
  ["Черновик", "Черновик"],
  ["На согласовании", "На согласовании"],
  ["Согласован", "Согласован"],
  ["Запланирован", "Запланирован"],
  ["Публикуется", "Публикуется"],
  ["Опубликован, проверяется", "Опубликован, проверяется"],
  ["Опубликован", "Опубликован"],
  ["Ожидает повтора", "Ожидает повтора"],
  ["Требует проверки", "Требует проверки"],
  ["Отменён", "Отменён"],
  ["Ошибка", "Ошибка"],
  ["Не найден во внешнем канале", "Не найден во внешнем канале"],
  ["Удалён во внешнем канале", "Удалён во внешнем канале"],
] as const;

const ANALYTICS_STATUSES = [
  ["", "Все подтверждённые"],
  ["Подтверждено", "Подтверждено площадкой"],
] as const;

const ACTIVE_STATUS_COPY: Record<string, { title: string; body: string }> = {
  pending: {
    title: "Запрос принят",
    body: "Снимок данных сохранён. Начинаем подготовку файла.",
  },
  queued: {
    title: "Файл готовится в фоне",
    body: "Можно закрыть окно: сервер продолжит работу. Статус сохранится в списке последних экспортов.",
  },
  rendering: {
    title: "Формируем файл",
    body: "Большая выборка занимает больше времени. Страница остаётся доступной.",
  },
  retryable_failed: {
    title: "Подготовка будет повторена",
    body: "Первая попытка не завершилась. Сервер повторит её автоматически; данные и фильтры сохранены.",
  },
};

const KIND_LABEL: Record<ClientProjectExportKind, string> = {
  content_plan: "Контент-план",
  analytics: "Аналитика",
};

function dateOnly(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function calendarProjectExportPeriod(
  view: "week" | "month",
  anchor: Date,
  weekStart: Date,
): { from: string; to: string } {
  if (view === "week") {
    const to = new Date(weekStart);
    to.setDate(to.getDate() + 6);
    return { from: dateOnly(weekStart), to: dateOnly(to) };
  }
  return {
    from: dateOnly(new Date(anchor.getFullYear(), anchor.getMonth(), 1)),
    to: dateOnly(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)),
  };
}

export function channelProjectExportValue(channel: RealChannel): string {
  const title = channel.title?.trim();
  if (title) return title;
  const handle = channel.handle?.replace(/^@/u, "").trim();
  if (handle) return `@${handle}`;
  if (channel.network === "tg") return "Telegram";
  if (channel.network === "vk") return "VK";
  return channel.network.toUpperCase();
}

function createInitialForm(input: {
  kind: ClientProjectExportKind;
  period?: { from: string; to: string };
  channels: RealChannel[];
  initialChannelId?: number | null;
}): ProjectExportFormValue {
  const period = input.period ?? defaultProjectExportPeriod(input.kind);
  const initialChannel = input.channels.find((channel) => channel.id === input.initialChannelId);
  return {
    kind: input.kind,
    format: "xlsx",
    from: period.from,
    to: period.to,
    channel: initialChannel ? channelProjectExportValue(initialChannel) : "",
    author: "",
    campaign: "",
    status: "",
  };
}

function triggerBrowserDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
}

function formatMoment(value: string): string {
  return new Date(value).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatPreviewMoment(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

export function ProjectExportPreviewPanel({
  preview,
  refreshing,
  onRefresh,
}: {
  preview: ClientProjectExportPreview;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="mt-6 rounded-md bg-surface-inset p-4 ring-1 ring-line sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={titleId} className="text-[15px] leading-snug font-bold text-text">
            Предварительная выборка
          </h3>
          <p className="mt-1 text-[13px] leading-relaxed text-text-2 tabular-nums">
            {preview.exceedsLimit
              ? "Найдено больше 25 000 строк. Уменьши период или добавь фильтр."
              : `Найдено строк: ${preview.rowCount.toLocaleString("ru-RU")}.`}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          loading={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Обновить выборку
        </Button>
      </div>

      {preview.sample.length === 0 ? (
        <p className="mt-4 max-w-[60ch] text-pretty text-[13px] leading-relaxed text-text-2">
          За выбранный период записей нет. Файл будет содержать заголовок, период и применённые фильтры.
        </p>
      ) : (
        <div className="mt-4">
          <p className="text-[12px] font-semibold text-text-3">Первые записи</p>
          <ol className="mt-2 space-y-3">
            {preview.sample.map((item) => (
              <li key={`${item.id}:${item.occurredAt}`} className="min-w-0 border-s-2 border-line-strong ps-3">
                <p className="break-words text-[13px] leading-relaxed font-semibold text-text [overflow-wrap:anywhere]">
                  {item.title}
                </p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-text-3 tabular-nums">
                  {formatPreviewMoment(item.occurredAt, preview.timezone)} · {item.channel} · {item.status}
                </p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-text-3">
                  Автор: {item.author}{item.campaign ? ` · Кампания: ${item.campaign}` : ""}
                </p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function operationIsExpired(operation: ClientProjectExportOperation): boolean {
  return operation.status === "expired"
    || Boolean(operation.status === "ready" && operation.artifact
      && Date.parse(operation.artifact.expiresAt) <= Date.now());
}

function operationStatusLabel(operation: ClientProjectExportOperation, revoked: boolean): string {
  if (revoked) return "Отозван";
  if (operationIsExpired(operation)) return "Срок истёк";
  if (operation.status === "ready") return "Готов";
  if (operation.status === "failed") return "Не сформирован";
  if (operation.status === "retryable_failed") return "Будет повторён";
  return "Готовится";
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
  allLabel,
  loading = false,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly ExportFilterOption[];
  allLabel: string;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[13px] font-semibold text-text-2">
        {label}
      </label>
      <select
        id={id}
        className={SELECT_CLASS}
        value={value}
        disabled={disabled || loading}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="">{loading ? "Загружаем…" : allLabel}</option>
        {value && !options.some((option) => option.value === value) ? (
          <option value={value}>{value} — сохранённый фильтр</option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

export function ProjectExportOperationPanel({
  operation,
  revoked,
  busy,
  onDownload,
  onRefresh,
  onRetry,
  onRevoke,
}: {
  operation: ClientProjectExportOperation;
  revoked: boolean;
  busy: "download" | "revoke" | "refresh" | null;
  onDownload: () => void;
  onRefresh: () => void;
  onRetry: () => void;
  onRevoke: () => void;
}) {
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const expired = operationIsExpired(operation);
  const active = isActiveProjectExport(operation.status) && !expired && !revoked;
  const ready = operation.status === "ready" && !expired && !revoked;
  const failed = operation.status === "failed";
  const activeCopy = ACTIVE_STATUS_COPY[operation.status] ?? ACTIVE_STATUS_COPY.queued;

  return (
    <section
      aria-labelledby={`export-operation-${operation.id}`}
      className={cn(
        "rounded-md p-4 ring-1 sm:p-5",
        ready
          ? "bg-success-soft text-success-text ring-success/25"
          : failed || expired || revoked
            ? "bg-danger-soft text-danger-text ring-danger/20"
            : "bg-info-soft text-info-text ring-brand/20",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0" aria-hidden>
          {active ? (
            <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
          ) : ready ? (
            <CheckCircle2 className="h-5 w-5" />
          ) : expired || revoked ? (
            <Clock3 className="h-5 w-5" />
          ) : (
            <AlertTriangle className="h-5 w-5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`export-operation-${operation.id}`} className="text-[15px] leading-snug font-bold">
            {revoked
              ? "Файл отозван"
              : expired
                ? "Срок скачивания закончился"
                : ready
                  ? "Файл готов"
                  : failed
                    ? "Файл не сформирован"
                    : activeCopy.title}
          </h3>
          <p className="mt-1 max-w-[65ch] text-pretty text-[13px] leading-relaxed">
            {revoked
              ? "Скачивание по ранее выданным ссылкам отключено. Фильтры сохранены — можно сформировать новый файл."
              : expired
                ? "Временный файл удалён или был отозван. Фильтры сохранены — сформируй экспорт заново."
                : ready
                  ? `${operation.artifact?.fileName} · ${formatBytes(operation.artifact?.byteSize ?? 0)}`
                  : failed
                    ? (operation.errorMessage || "Данные проекта не изменились. Повтори подготовку с теми же фильтрами.")
                    : activeCopy.body}
          </p>
          {ready && operation.artifact ? (
            <p className="mt-1 text-[12px] leading-relaxed tabular-nums opacity-80">
              Скачать можно до {formatMoment(operation.artifact.expiresAt)}.
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {ready ? (
          <Button type="button" variant="solid" size="sm" disabled={busy !== null && busy !== "download"} loading={busy === "download"} onClick={onDownload}>
            <Download className="h-4 w-4" aria-hidden />
            Скачать файл
          </Button>
        ) : null}
        {active ? (
          <Button type="button" variant="soft" size="sm" disabled={busy !== null && busy !== "refresh"} loading={busy === "refresh"} onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Проверить статус
          </Button>
        ) : null}
        {failed || expired || revoked ? (
          <Button type="button" variant="solid" size="sm" disabled={busy !== null} onClick={onRetry}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Проверить выборку заново
          </Button>
        ) : null}
        {(ready || active) && !confirmRevoke ? (
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmRevoke(true)}>
            {active ? "Остановить подготовку" : "Отозвать файл"}
          </Button>
        ) : null}
      </div>

      {confirmRevoke ? (
        <div className="mt-4 rounded-sm bg-surface p-3 text-text ring-1 ring-line" role="group" aria-label="Подтверждение отзыва">
          <p className="text-[13px] leading-relaxed">
            {active
              ? "Остановить этот экспорт? Готовый файл не появится, но исходные данные проекта останутся без изменений."
              : "Отозвать этот файл? Все ранее выданные временные ссылки перестанут работать."}
          </p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={busy === "revoke"} onClick={() => setConfirmRevoke(false)}>
              Оставить
            </Button>
            <Button type="button" variant="danger" size="sm" loading={busy === "revoke"} onClick={onRevoke}>
              {active ? "Остановить экспорт" : "Отозвать файл"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ProjectExportButtonForProject({
  projectId,
  projectName,
  channels,
  defaultKind,
  initialPeriod,
  initialChannelId,
}: {
  projectId: number;
  projectName: string;
  channels: RealChannel[];
  defaultKind: ClientProjectExportKind;
  initialPeriod?: { from: string; to: string };
  initialChannelId?: number | null;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const periodErrorId = useId();
  const dialogId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(false);
  const operationRef = useRef<ClientProjectExportOperation | null>(null);
  const autoDownloadRef = useRef(new Set<number>());
  const metadataSequence = useRef(0);

  const initialForm = useMemo(() => createInitialForm({
    kind: defaultKind,
    period: initialPeriod,
    channels,
    initialChannelId,
  }), [channels, defaultKind, initialChannelId, initialPeriod]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProjectExportFormValue>(initialForm);
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "error" | "info" | "success"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ClientProjectExportPreview | null>(null);
  const [operation, setOperation] = useState<ClientProjectExportOperation | null>(null);
  const [recents, setRecents] = useState<ClientProjectExportOperation[]>([]);
  const [recentsLoading, setRecentsLoading] = useState(false);
  const [recentsError, setRecentsError] = useState(false);
  const [authors, setAuthors] = useState<ExportFilterOption[]>([]);
  const [campaigns, setCampaigns] = useState<ExportFilterOption[]>([]);
  const [authorsLoading, setAuthorsLoading] = useState(false);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [authorsError, setAuthorsError] = useState(false);
  const [campaignsError, setCampaignsError] = useState(false);
  const [operationBusy, setOperationBusy] = useState<"download" | "revoke" | "refresh" | null>(null);
  const [revokedIds, setRevokedIds] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    operationRef.current = operation;
  }, [operation]);

  const channelOptions = useMemo<ExportFilterOption[]>(() => {
    const seen = new Set<string>();
    const result: ExportFilterOption[] = [];
    for (const channel of channels.filter((item) => item.is_active)) {
      const value = channelProjectExportValue(channel);
      const key = value.toLocaleLowerCase("ru-RU");
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ value, label: value });
      }
    }
    return result;
  }, [channels]);

  const updateRecent = useCallback((next: ClientProjectExportOperation) => {
    setRecents((current) => [next, ...current.filter((item) => item.id !== next.id)].slice(0, 10));
  }, []);

  const updateSelection = useCallback((patch: Partial<ProjectExportFormValue>) => {
    setForm((current) => ({ ...current, ...patch }));
    setPreview(null);
    setPeriodError(null);
    setFeedback(null);
  }, []);

  const downloadFile = useCallback(async (
    target: ClientProjectExportOperation,
    automatic = false,
  ) => {
    if (automatic) {
      if (autoDownloadRef.current.has(target.id)) return;
      autoDownloadRef.current.add(target.id);
    }
    setOperationBusy("download");
    setFeedback(null);
    try {
      const file = await downloadProjectExport(target);
      triggerBrowserDownload(file.blob, file.fileName);
      setFeedback({ kind: "success", text: "Файл получен и передан браузеру для скачивания." });
    } catch (error) {
      if (automatic) autoDownloadRef.current.delete(target.id);
      setFeedback({ kind: "error", text: projectExportErrorMessage(error) });
      if (
        error instanceof ProjectExportClientError
        && (error.code === "export_expired" || error.code === "download_not_found")
      ) {
        const expired = { ...target, status: "expired" as const };
        setOperation(expired);
        updateRecent(expired);
      }
    } finally {
      setOperationBusy(null);
    }
  }, [updateRecent]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      const frame = requestAnimationFrame(() => firstFieldRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const loadSupportingData = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++metadataSequence.current;
    setRecentsLoading(true);
    setRecentsError(false);
    setAuthorsLoading(true);
    setAuthorsError(false);
    setCampaignsLoading(true);
    setCampaignsError(false);

    const recentPromise = listProjectExports(signal)
      .then((items) => {
        if (sequence !== metadataSequence.current) return;
        setRecents(items);
        setRecentsError(false);
        const active = items.find((item) => isActiveProjectExport(item.status));
        if (active && !operationRef.current) {
          setOperation(active);
        }
      })
      .catch((error) => {
        if (sequence === metadataSequence.current && !(error instanceof Error && error.name === "AbortError")) {
          setRecentsError(true);
        }
      })
      .finally(() => {
        if (sequence === metadataSequence.current) setRecentsLoading(false);
      });

    const membersPromise = fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
      cache: "no-store",
      signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        const parsed = response.ok ? parseExportAuthorOptions(body) : null;
        if (!parsed) throw new Error("members_unavailable");
        if (sequence === metadataSequence.current) setAuthors(parsed);
      })
      .catch((error) => {
        if (sequence === metadataSequence.current && !(error instanceof Error && error.name === "AbortError")) {
          setAuthorsError(true);
        }
      })
      .finally(() => {
        if (sequence === metadataSequence.current) setAuthorsLoading(false);
      });

    const campaignsPromise = fetch("/api/monthly-campaigns", {
      cache: "no-store",
      signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        const parsed = response.ok ? parseExportCampaignOptions(body) : null;
        if (!parsed) throw new Error("campaigns_unavailable");
        if (sequence === metadataSequence.current) setCampaigns(parsed);
      })
      .catch((error) => {
        if (sequence === metadataSequence.current && !(error instanceof Error && error.name === "AbortError")) {
          setCampaignsError(true);
        }
      })
      .finally(() => {
        if (sequence === metadataSequence.current) setCampaignsLoading(false);
      });

    await Promise.all([recentPromise, membersPromise, campaignsPromise]);
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadSupportingData(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadSupportingData, open]);

  const pollOperationId = operation && isActiveProjectExport(operation.status) ? operation.id : null;
  useEffect(() => {
    if (!pollOperationId) return;
    const controller = new AbortController();
    let cancelled = false;
    const poll = async () => {
      for (let attempt = 0; attempt < 120 && !cancelled; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt < 12 ? 1_500 : 5_000));
        if (cancelled) return;
        try {
          const next = await getProjectExport(pollOperationId, controller.signal);
          if (cancelled) return;
          setOperation(next);
          updateRecent(next);
          if (!isActiveProjectExport(next.status)) {
            if (next.status === "ready" && openRef.current) void downloadFile(next, true);
            return;
          }
        } catch (error) {
          if (cancelled || (error instanceof Error && error.name === "AbortError")) return;
          if (attempt === 119) {
            setFeedback({
              kind: "info",
              text: "Подготовка продолжается. Автоматическая проверка приостановлена — проверь статус вручную позже.",
            });
          }
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [downloadFile, pollOperationId, updateRecent]);

  const runPreview = useCallback(async (value: ProjectExportFormValue) => {
    const validation = validateProjectExportPeriod(value);
    if (validation) {
      setPeriodError(validation);
      requestAnimationFrame(() => fromRef.current?.focus());
      return;
    }
    setPeriodError(null);
    setFeedback(null);
    setPreviewing(true);
    try {
      const next = await previewProjectExport(value);
      setPreview(next);
      setFeedback({
        kind: next.exceedsLimit ? "error" : "info",
        text: next.exceedsLimit
          ? "Файл пока нельзя сформировать: сократи период или добавь фильтр."
          : "Выборка проверена сервером. Просмотри первые записи и сформируй файл.",
      });
    } catch (error) {
      setPreview(null);
      setFeedback({ kind: "error", text: projectExportErrorMessage(error) });
    } finally {
      setPreviewing(false);
    }
  }, []);

  const runExport = useCallback(async (value: ProjectExportFormValue, previewHash: string) => {
    const validation = validateProjectExportPeriod(value);
    if (validation) {
      setPeriodError(validation);
      setPreview(null);
      requestAnimationFrame(() => fromRef.current?.focus());
      return;
    }
    setPeriodError(null);
    setFeedback(null);
    setSubmitting(true);
    try {
      const next = await createProjectExport(value, crypto.randomUUID(), previewHash);
      setOperation(next);
      updateRecent(next);
      if (next.status === "ready") {
        await downloadFile(next, true);
      } else if (isActiveProjectExport(next.status)) {
        setFeedback({ kind: "info", text: "Запрос принят. Файл готовится в фоне." });
      } else if (next.status === "failed") {
        setFeedback({ kind: "error", text: next.errorMessage || "Файл не сформирован. Повтори запрос." });
      } else if (next.status === "expired") {
        setFeedback({ kind: "error", text: "Срок файла закончился. Сформируй экспорт заново." });
      }
    } catch (error) {
      if (error instanceof ProjectExportClientError && error.code === "preview_stale") {
        setPreview(null);
      }
      setFeedback({ kind: "error", text: projectExportErrorMessage(error) });
    } finally {
      setSubmitting(false);
    }
  }, [downloadFile, updateRecent]);

  const refreshOperation = useCallback(async () => {
    if (!operation) return;
    setOperationBusy("refresh");
    setFeedback(null);
    try {
      const next = await getProjectExport(operation.id);
      setOperation(next);
      updateRecent(next);
      if (next.status === "ready") await downloadFile(next, true);
    } catch (error) {
      setFeedback({ kind: "error", text: projectExportErrorMessage(error) });
    } finally {
      setOperationBusy(null);
    }
  }, [downloadFile, operation, updateRecent]);

  const revokeOperation = useCallback(async () => {
    if (!operation) return;
    setOperationBusy("revoke");
    setFeedback(null);
    try {
      await revokeProjectExport(operation.id);
      setRevokedIds((current) => new Set(current).add(operation.id));
      const expired = { ...operation, status: "expired" as const };
      setOperation(expired);
      updateRecent(expired);
      setFeedback({ kind: "info", text: "Экспорт отозван. Исходные данные проекта не изменились." });
    } catch (error) {
      setFeedback({ kind: "error", text: projectExportErrorMessage(error) });
    } finally {
      setOperationBusy(null);
    }
  }, [operation, updateRecent]);

  const retryOperation = useCallback(() => {
    if (!operation) return;
    const restored = projectExportFormFromOperation(operation);
    setForm(restored);
    setPreview(null);
    setFeedback(null);
    void runPreview(restored);
  }, [operation, runPreview]);

  const showOperation = useCallback((next: ClientProjectExportOperation) => {
    setOperation(next);
    setForm(projectExportFormFromOperation(next));
    setPreview(null);
    setPeriodError(null);
    setFeedback(null);
  }, []);

  const statusOptions = form.kind === "analytics" ? ANALYTICS_STATUSES : CONTENT_STATUSES;
  const closeDialog = useCallback(() => {
    openRef.current = false;
    setOpen(false);
  }, []);

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="md"
        aria-haspopup="dialog"
        aria-controls={dialogId}
        onClick={() => {
          openRef.current = true;
          setOpen(true);
        }}
      >
        <FileDown className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
        Экспортировать
      </Button>

      <dialog
        id={dialogId}
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={cn(
          "m-auto max-h-[calc(100dvh-2rem)] w-[min(44rem,calc(100%-2rem))] max-w-none overflow-y-auto overscroll-contain",
          "rounded-lg bg-surface p-0 text-text shadow-float ring-1 ring-line",
          "backdrop:bg-text/45 backdrop:backdrop-blur-[2px]",
        )}
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          closeDialog();
        }}
        onClose={() => {
          openRef.current = false;
          setOpen(false);
          requestAnimationFrame(() => triggerRef.current?.focus());
        }}
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-surface/95 px-4 py-4 backdrop-blur-md sm:px-6">
          <div className="min-w-0">
            <h2 id={titleId} className="text-balance text-[20px] leading-tight font-extrabold tracking-tight text-text sm:text-[22px]">
              Экспортировать данные
            </h2>
            <p id={descriptionId} className="mt-1 max-w-[60ch] text-pretty text-[13px] leading-relaxed text-text-2">
              Выгрузка относится к проекту «{projectName}». Проект проверяется сервером и не передаётся в параметрах экспорта.
            </p>
          </div>
          <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label="Закрыть экспорт" onClick={closeDialog}>
            <X className="h-5 w-5" strokeWidth={2} aria-hidden />
          </Button>
        </div>

        <div className="space-y-6 px-4 py-5 sm:px-6 sm:py-6">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (preview && !preview.exceedsLimit) {
                void runExport(form, preview.previewHash);
              } else {
                void runPreview(form);
              }
            }}
          >
            <div className="grid gap-6 sm:grid-cols-2">
              <fieldset>
                <legend className="text-[13px] font-semibold text-text-2">Что экспортировать</legend>
                <div className="mt-2 grid grid-cols-1 gap-2 min-[24rem]:grid-cols-2">
                  {(["content_plan", "analytics"] as const).map((kind) => (
                    <label
                      key={kind}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xs px-3 text-[14px] font-semibold ring-1",
                        "transition-colors duration-150 focus-within:ring-4 focus-within:ring-brand/15",
                        form.kind === kind ? "bg-info-soft text-info-text ring-brand/35" : "bg-surface-inset text-text-2 ring-line",
                      )}
                    >
                      <input
                        ref={form.kind === kind ? firstFieldRef : undefined}
                        type="radio"
                        name="project-export-kind"
                        value={kind}
                        checked={form.kind === kind}
                        onChange={() => updateSelection({ kind, status: "" })}
                        className="h-4 w-4 accent-[var(--brand-1)]"
                      />
                      {KIND_LABEL[kind]}
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="text-[13px] font-semibold text-text-2">Формат файла</legend>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {(["xlsx", "csv", "pdf"] as const).map((format) => (
                    <label
                      key={format}
                      className={cn(
                        "flex min-h-11 cursor-pointer items-center justify-center rounded-xs px-2 text-[13px] font-bold uppercase ring-1",
                        "transition-colors duration-150 focus-within:ring-4 focus-within:ring-brand/15",
                        form.format === format ? "bg-info-soft text-info-text ring-brand/35" : "bg-surface-inset text-text-2 ring-line",
                      )}
                    >
                      <input
                        type="radio"
                        name="project-export-format"
                        value={format}
                        checked={form.format === format}
                        onChange={() => setForm((current) => ({ ...current, format }))}
                        className="sr-only"
                      />
                      {format}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            <fieldset className="mt-6" aria-describedby={periodError ? periodErrorId : undefined}>
              <legend className="text-[13px] font-semibold text-text-2">Период</legend>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor={`${periodErrorId}-from`} className="block text-[13px] text-text-2">С даты</label>
                  <input
                    ref={fromRef}
                    id={`${periodErrorId}-from`}
                    type="date"
                    value={form.from}
                    aria-invalid={Boolean(periodError) || undefined}
                    className={cn(DATE_CLASS, periodError && "border-danger")}
                    onChange={(event) => updateSelection({ from: event.currentTarget.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor={`${periodErrorId}-to`} className="block text-[13px] text-text-2">По дату</label>
                  <input
                    id={`${periodErrorId}-to`}
                    type="date"
                    value={form.to}
                    aria-invalid={Boolean(periodError) || undefined}
                    className={cn(DATE_CLASS, periodError && "border-danger")}
                    onChange={(event) => updateSelection({ to: event.currentTarget.value })}
                  />
                </div>
              </div>
              {periodError ? <p id={periodErrorId} role="alert" className="mt-2 text-[13px] font-medium text-danger-text">{periodError}</p> : null}
            </fieldset>

            <details className="mt-6 rounded-md bg-surface-inset px-4 ring-1 ring-line">
              <summary className="flex min-h-11 cursor-pointer items-center text-[14px] font-semibold text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                Фильтры выборки
              </summary>
              <div className="grid gap-4 pb-4 sm:grid-cols-2">
                <FilterSelect
                  id={`${periodErrorId}-channel`}
                  label="Канал"
                  value={form.channel}
                  onChange={(channel) => updateSelection({ channel })}
                  options={channelOptions}
                  allLabel="Все каналы"
                />
                <div className="space-y-1.5">
                  <label htmlFor={`${periodErrorId}-status`} className="block text-[13px] font-semibold text-text-2">Статус</label>
                  <select
                    id={`${periodErrorId}-status`}
                    className={SELECT_CLASS}
                    value={form.status}
                    onChange={(event) => updateSelection({ status: event.currentTarget.value })}
                  >
                    {statusOptions.map(([value, label]) => <option key={value || "all"} value={value}>{label}</option>)}
                  </select>
                </div>
                <FilterSelect
                  id={`${periodErrorId}-author`}
                  label="Автор"
                  value={form.author}
                  onChange={(author) => updateSelection({ author })}
                  options={authors}
                  allLabel={authorsError ? "Все авторы — список недоступен" : "Все авторы"}
                  loading={authorsLoading}
                />
                <FilterSelect
                  id={`${periodErrorId}-campaign`}
                  label="Кампания"
                  value={form.campaign}
                  onChange={(campaign) => updateSelection({ campaign })}
                  options={campaigns}
                  allLabel={campaignsError ? "Все кампании — список недоступен" : "Все кампании"}
                  loading={campaignsLoading}
                />
              </div>
              {authorsError || campaignsError ? (
                <p className="pb-4 text-[12px] leading-relaxed text-text-3">
                  Часть списков не загрузилась. Экспорт по периоду, каналу и статусу продолжает работать; выбранные ранее фильтры не сброшены.
                </p>
              ) : null}
            </details>

            {preview ? (
              <ProjectExportPreviewPanel
                preview={preview}
                refreshing={previewing}
                onRefresh={() => void runPreview(form)}
              />
            ) : null}

            <div className="mt-6 flex flex-col-reverse gap-2 min-[24rem]:flex-row min-[24rem]:items-center min-[24rem]:justify-between">
              <p className="flex max-w-[42ch] items-start gap-2 text-[12px] leading-relaxed text-text-3">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                Ссылка на скачивание действует временно. Файл доступен только участнику текущего проекта.
              </p>
              <Button
                type="submit"
                variant="brand"
                size="md"
                disabled={Boolean(preview?.exceedsLimit)}
                loading={preview ? submitting : previewing}
              >
                {preview ? <FileDown className="h-[18px] w-[18px]" aria-hidden /> : <ShieldCheck className="h-[18px] w-[18px]" aria-hidden />}
                {preview?.exceedsLimit
                  ? "Уточни выборку"
                  : preview
                    ? "Сформировать файл"
                    : "Проверить выборку"}
              </Button>
            </div>
          </form>

          <div aria-live="polite" aria-atomic="true" className="min-h-0">
            {feedback ? (
              <p
                role={feedback.kind === "error" ? "alert" : "status"}
                className={cn(
                  "rounded-sm px-3 py-2.5 text-[13px] leading-relaxed ring-1",
                  feedback.kind === "error"
                    ? "bg-danger-soft text-danger-text ring-danger/20"
                    : feedback.kind === "success"
                      ? "bg-success-soft text-success-text ring-success/20"
                      : "bg-info-soft text-info-text ring-brand/20",
                )}
              >
                {feedback.text}
              </p>
            ) : null}
          </div>

          {operation ? (
            <ProjectExportOperationPanel
              key={`${operation.id}:${operation.status}`}
              operation={operation}
              revoked={revokedIds.has(operation.id)}
              busy={operationBusy}
              onDownload={() => void downloadFile(operation)}
              onRefresh={() => void refreshOperation()}
              onRetry={retryOperation}
              onRevoke={() => void revokeOperation()}
            />
          ) : null}

          <details className="rounded-md px-1">
            <summary className="flex min-h-11 cursor-pointer items-center text-[14px] font-semibold text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
              Последние экспорты{recents.length ? ` (${recents.length})` : ""}
            </summary>
            {recentsLoading ? (
              <p className="py-3 text-[13px] text-text-2" role="status">Загружаем список…</p>
            ) : recentsError ? (
              <div className="flex flex-wrap items-center justify-between gap-2 py-3" role="alert">
                <p className="text-[13px] text-danger-text">Список не загрузился. Текущие фильтры сохранены.</p>
                <Button type="button" variant="ghost" size="sm" onClick={() => void loadSupportingData()}>Повторить загрузку</Button>
              </div>
            ) : recents.length === 0 ? (
              <p className="py-3 text-[13px] leading-relaxed text-text-2">
                Здесь появятся готовые файлы и незавершённые запросы этого проекта.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {recents.slice(0, 5).map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex min-h-11 w-full items-center justify-between gap-3 py-3 text-start transition-colors duration-150 hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                      onClick={() => showOperation(item)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-text">
                          {KIND_LABEL[item.kind]} · {item.format.toUpperCase()}
                        </span>
                        <span className="mt-0.5 block text-[12px] tabular-nums text-text-3">
                          {formatMoment(item.createdAt)}
                        </span>
                      </span>
                      <span className="shrink-0 text-[12px] font-semibold text-text-2">
                        {operationStatusLabel(item, revokedIds.has(item.id))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      </dialog>
    </>
  );
}

export function ProjectExportButton({
  channels,
  defaultKind,
  initialPeriod,
  initialChannelId = null,
}: {
  channels: RealChannel[];
  defaultKind: ClientProjectExportKind;
  initialPeriod?: { from: string; to: string };
  initialChannelId?: number | null;
}) {
  const projects = useProjects();
  const project = projects.current;
  if (!projects.ready || !project) {
    return (
      <Button type="button" variant="outline" size="md" disabled aria-label="Экспорт недоступен: проект не выбран">
        <FileDown className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
        Экспортировать
      </Button>
    );
  }
  return (
    <ProjectExportButtonForProject
      key={`${project.id}:${defaultKind}:${initialPeriod?.from ?? "default"}:${initialPeriod?.to ?? "default"}:${initialChannelId ?? "all"}`}
      projectId={project.id}
      projectName={project.name}
      channels={channels}
      defaultKind={defaultKind}
      initialPeriod={initialPeriod}
      initialChannelId={initialChannelId}
    />
  );
}
