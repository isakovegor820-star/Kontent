export type ClientProjectExportKind = "content_plan" | "analytics";
export type ClientProjectExportFormat = "csv" | "xlsx" | "pdf";
export type ClientProjectExportStatus =
  | "pending"
  | "queued"
  | "rendering"
  | "ready"
  | "retryable_failed"
  | "failed"
  | "expired";

export type ClientProjectExportFilters = {
  period: { from: string; to: string };
  channel: string[];
  author: string[];
  campaign: string[];
  status: string[];
};

export type ClientProjectExportPreview = {
  kind: ClientProjectExportKind;
  timezone: string;
  period: { from: string; to: string };
  filters: Omit<ClientProjectExportFilters, "period">;
  rowCount: number;
  exceedsLimit: boolean;
  previewHash: string;
  sample: Array<{
    id: string;
    occurredAt: string;
    channel: string;
    title: string;
    status: string;
    author: string;
    campaign: string;
  }>;
};

export type ClientProjectExportOperation = {
  id: number;
  kind: ClientProjectExportKind;
  format: ClientProjectExportFormat;
  status: ClientProjectExportStatus;
  filters: ClientProjectExportFilters;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  artifact: null | {
    byteSize: number;
    fileName: string;
    mimeType: string;
    expiresAt: string;
  };
};

export type ProjectExportFormValue = {
  kind: ClientProjectExportKind;
  format: ClientProjectExportFormat;
  from: string;
  to: string;
  channel: string;
  author: string;
  campaign: string;
  status: string;
};

export type ExportFilterOption = { value: string; label: string };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const EXPORT_KINDS = new Set<ClientProjectExportKind>(["content_plan", "analytics"]);
const EXPORT_FORMATS = new Set<ClientProjectExportFormat>(["csv", "xlsx", "pdf"]);
const EXPORT_STATUSES = new Set<ClientProjectExportStatus>([
  "pending",
  "queued",
  "rendering",
  "ready",
  "retryable_failed",
  "failed",
  "expired",
]);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function nullableText(value: unknown): string | null | undefined {
  return value == null ? null : typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): string[] | null {
  if (value == null) return [];
  const input = Array.isArray(value) ? value : [value];
  if (!input.every((item) => typeof item === "string")) return null;
  return input.map((item) => item.trim()).filter(Boolean);
}

function parseFilters(value: unknown): ClientProjectExportFilters | null {
  if (!isRecord(value)) return null;
  const period = isRecord(value.period) ? value.period : null;
  const from = period?.from;
  const to = period?.to;
  if (typeof from !== "string" || typeof to !== "string" || !DATE_ONLY.test(from) || !DATE_ONLY.test(to)) {
    return null;
  }
  const channel = stringList(value.channel);
  const author = stringList(value.author);
  const campaign = stringList(value.campaign);
  const status = stringList(value.status);
  if (!channel || !author || !campaign || !status) return null;
  return { period: { from, to }, channel, author, campaign, status };
}

function parseArtifact(value: unknown): ClientProjectExportOperation["artifact"] | undefined {
  if (value == null) return null;
  if (!isRecord(value)) return undefined;
  const byteSize = Number(value.byteSize);
  if (
    !Number.isSafeInteger(byteSize)
    || byteSize < 0
    || typeof value.fileName !== "string"
    || !value.fileName.trim()
    || typeof value.mimeType !== "string"
    || !value.mimeType.trim()
    || !isIsoDateTime(value.expiresAt)
  ) return undefined;
  return {
    byteSize,
    fileName: value.fileName,
    mimeType: value.mimeType,
    expiresAt: value.expiresAt,
  };
}

export function parseProjectExportOperation(value: unknown): ClientProjectExportOperation | null {
  if (!isRecord(value)) return null;
  const id = Number(value.id);
  const kind = value.kind as ClientProjectExportKind;
  const format = value.format as ClientProjectExportFormat;
  const status = value.status as ClientProjectExportStatus;
  const filters = parseFilters(value.filters);
  const artifact = parseArtifact(value.artifact);
  const errorCode = nullableText(value.errorCode);
  const errorMessage = nullableText(value.errorMessage);
  const completedAt = value.completedAt == null ? null : value.completedAt;
  if (
    !Number.isSafeInteger(id)
    || id <= 0
    || !EXPORT_KINDS.has(kind)
    || !EXPORT_FORMATS.has(format)
    || !EXPORT_STATUSES.has(status)
    || !filters
    || artifact === undefined
    || (status === "ready" && artifact === null)
    || errorCode === undefined
    || errorMessage === undefined
    || !isIsoDateTime(value.createdAt)
    || !isIsoDateTime(value.updatedAt)
    || (completedAt !== null && !isIsoDateTime(completedAt))
  ) return null;
  return {
    id,
    kind,
    format,
    status,
    filters,
    errorCode,
    errorMessage,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt,
    artifact,
  };
}

export function parseProjectExportList(value: unknown): ClientProjectExportOperation[] | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.exports)) return null;
  const operations = value.exports.map(parseProjectExportOperation);
  return operations.every((operation): operation is ClientProjectExportOperation => operation !== null)
    ? operations
    : null;
}

export function parseProjectExportPreview(value: unknown): ClientProjectExportPreview | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.preview)) return null;
  const preview = value.preview;
  const kind = preview.kind as ClientProjectExportKind;
  const period = isRecord(preview.period) ? preview.period : null;
  const filters = isRecord(preview.filters) ? preview.filters : null;
  const channel = stringList(filters?.channel);
  const author = stringList(filters?.author);
  const campaign = stringList(filters?.campaign);
  const status = stringList(filters?.status);
  const rowCount = Number(preview.rowCount);
  if (
    !EXPORT_KINDS.has(kind)
    || !isTimezone(preview.timezone)
    || typeof period?.from !== "string"
    || typeof period?.to !== "string"
    || !DATE_ONLY.test(period.from)
    || !DATE_ONLY.test(period.to)
    || !channel || !author || !campaign || !status
    || !Number.isSafeInteger(rowCount) || rowCount < 0
    || typeof preview.exceedsLimit !== "boolean"
    || typeof preview.previewHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(preview.previewHash)
    || !Array.isArray(preview.sample)
    || preview.sample.length > 5
  ) return null;
  const sample = preview.sample.map((item) => {
    if (!isRecord(item)) return null;
    if (
      typeof item.id !== "string"
      || !isIsoDateTime(item.occurredAt)
      || typeof item.channel !== "string"
      || typeof item.title !== "string"
      || typeof item.status !== "string"
      || typeof item.author !== "string"
      || typeof item.campaign !== "string"
    ) return null;
    return {
      id: item.id,
      occurredAt: item.occurredAt,
      channel: item.channel,
      title: item.title,
      status: item.status,
      author: item.author,
      campaign: item.campaign,
    };
  });
  if (!sample.every((item): item is NonNullable<typeof item> => item !== null)) return null;
  return {
    kind,
    timezone: preview.timezone,
    period: { from: period.from, to: period.to },
    filters: { channel, author, campaign, status },
    rowCount,
    exceedsLimit: preview.exceedsLimit,
    previewHash: preview.previewHash,
    sample,
  };
}

function dateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function defaultProjectExportPeriod(
  kind: ClientProjectExportKind,
  now = new Date(),
): { from: string; to: string } {
  if (kind === "content_plan") {
    return {
      from: dateOnly(new Date(now.getFullYear(), now.getMonth(), 1)),
      to: dateOnly(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    };
  }
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
  return { from: dateOnly(from), to: dateOnly(now) };
}

export function projectExportFormFromOperation(
  operation: ClientProjectExportOperation,
): ProjectExportFormValue {
  return {
    kind: operation.kind,
    format: operation.format,
    from: operation.filters.period.from,
    to: operation.filters.period.to,
    channel: operation.filters.channel[0] ?? "",
    author: operation.filters.author[0] ?? "",
    campaign: operation.filters.campaign[0] ?? "",
    status: operation.filters.status[0] ?? "",
  };
}

export function validateProjectExportPeriod(value: Pick<ProjectExportFormValue, "from" | "to">): string | null {
  if (!DATE_ONLY.test(value.from) || !DATE_ONLY.test(value.to)) {
    return "Выбери начало и конец периода.";
  }
  const from = Date.parse(`${value.from}T00:00:00.000Z`);
  const to = Date.parse(`${value.to}T00:00:00.000Z`);
  const days = (to - from) / 86_400_000 + 1;
  if (!Number.isFinite(days) || days < 1) return "Дата окончания должна быть не раньше даты начала.";
  if (days > 366) return "Выбери период не больше 366 дней.";
  return null;
}

export function projectExportRequestBody(value: ProjectExportFormValue, previewHash?: string) {
  const compact = (item: string) => item.trim() ? [item.trim()] : [];
  return {
    kind: value.kind,
    format: value.format,
    period: { from: value.from, to: value.to },
    filters: {
      channel: compact(value.channel),
      author: compact(value.author),
      campaign: compact(value.campaign),
      status: compact(value.status),
    },
    ...(previewHash ? { previewHash } : {}),
  };
}

export class ProjectExportClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 0) {
    super(code);
    this.name = "ProjectExportClientError";
    this.code = code;
    this.status = status;
  }
}

async function responseBody(response: Response): Promise<Record<string, unknown> | null> {
  const value = await response.json().catch(() => null);
  return isRecord(value) ? value : null;
}

function responseError(response: Response, body: Record<string, unknown> | null): ProjectExportClientError {
  return new ProjectExportClientError(
    typeof body?.error === "string" ? body.error : response.status === 429 ? "rate_limited" : "server",
    response.status,
  );
}

export function projectExportErrorMessage(error: unknown): string {
  const code = error instanceof ProjectExportClientError ? error.code : "network";
  switch (code) {
    case "invalid_period":
      return "Проверь даты: период должен быть не больше 366 дней.";
    case "invalid_filters":
      return "Один из фильтров больше недоступен. Обнови список и выбери его заново.";
    case "export_too_large":
      return "В выбранном периоде слишком много строк. Уменьши период или добавь фильтр.";
    case "preview_required":
      return "Сначала проверь выборку, затем сформируй файл.";
    case "preview_stale":
      return "Данные изменились после проверки выборки. Обнови выборку и повтори экспорт.";
    case "access_denied":
    case "project_not_found":
      return "Нет доступа к выбранному проекту. Переключи проект или попроси владельца проверить роль.";
    case "selected_project_changed":
      return "Проект изменился во время запроса. Проверь текущий проект и повтори экспорт.";
    case "rate_limited":
      return "Слишком много запросов экспорта. Подожди немного и повтори.";
    case "export_not_ready":
      return "Файл ещё готовится. Проверь статус через несколько секунд.";
    case "export_expired":
    case "download_not_found":
      return "Срок скачивания закончился или файл был отозван. Сформируй его заново.";
    case "unauthorized":
      return "Сессия завершилась. Войди снова, затем повтори экспорт.";
    case "forbidden_origin":
      return "Запрос отклонён защитой браузера. Обнови страницу и повтори.";
    case "idempotency_conflict":
      return "Параметры изменились во время отправки. Повтори экспорт с текущими фильтрами.";
    default:
      return "Не удалось выполнить запрос. Проверь подключение и попробуй снова.";
  }
}

export function isActiveProjectExport(status: ClientProjectExportStatus): boolean {
  return status === "pending" || status === "queued" || status === "rendering" || status === "retryable_failed";
}

export async function listProjectExports(
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<ClientProjectExportOperation[]> {
  let response: Response;
  try {
    response = await fetcher("/api/project-exports?limit=10", { cache: "no-store", signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ProjectExportClientError("network");
  }
  const body = await responseBody(response);
  if (!response.ok) throw responseError(response, body);
  const operations = parseProjectExportList(body);
  if (!operations) throw new ProjectExportClientError("invalid_response", response.status);
  return operations;
}

export async function createProjectExport(
  value: ProjectExportFormValue,
  idempotencyKey: string,
  previewHash: string,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<ClientProjectExportOperation> {
  const periodError = validateProjectExportPeriod(value);
  if (periodError) throw new ProjectExportClientError("invalid_period");
  let response: Response;
  try {
    response = await fetcher("/api/project-exports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(projectExportRequestBody(value, previewHash)),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ProjectExportClientError("network");
  }
  const body = await responseBody(response);
  if (!response.ok) throw responseError(response, body);
  const operation = parseProjectExportOperation(body?.operation);
  if (!operation) throw new ProjectExportClientError("invalid_response", response.status);
  return operation;
}

export async function previewProjectExport(
  value: ProjectExportFormValue,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<ClientProjectExportPreview> {
  const periodError = validateProjectExportPeriod(value);
  if (periodError) throw new ProjectExportClientError("invalid_period");
  let response: Response;
  try {
    response = await fetcher("/api/project-exports/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(projectExportRequestBody(value)),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ProjectExportClientError("network");
  }
  const body = await responseBody(response);
  if (!response.ok) throw responseError(response, body);
  const preview = parseProjectExportPreview(body);
  if (!preview) throw new ProjectExportClientError("invalid_response", response.status);
  return preview;
}

export async function getProjectExport(
  operationId: number,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<ClientProjectExportOperation> {
  let response: Response;
  try {
    response = await fetcher(`/api/project-exports/${encodeURIComponent(operationId)}`, {
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ProjectExportClientError("network");
  }
  const body = await responseBody(response);
  if (!response.ok) throw responseError(response, body);
  const operation = parseProjectExportOperation(body?.operation);
  if (!operation) throw new ProjectExportClientError("invalid_response", response.status);
  return operation;
}

export async function revokeProjectExport(
  operationId: number,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(`/api/project-exports/${encodeURIComponent(operationId)}`, {
      method: "DELETE",
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ProjectExportClientError("network");
  }
  const body = await responseBody(response);
  if (!response.ok) throw responseError(response, body);
  if (body?.ok !== true || !isRecord(body.operation) || body.operation.status !== "expired") {
    throw new ProjectExportClientError("invalid_response", response.status);
  }
}

export async function downloadProjectExport(
  operation: ClientProjectExportOperation,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<{ blob: Blob; fileName: string }> {
  if (operation.status !== "ready" || !operation.artifact) {
    throw new ProjectExportClientError("export_not_ready", 409);
  }
  let tokenResponse: Response;
  try {
    tokenResponse = await fetcher(
      `/api/project-exports/${encodeURIComponent(operation.id)}/download-token`,
      { method: "POST", signal },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ProjectExportClientError("network");
  }
  const tokenBody = await responseBody(tokenResponse);
  if (!tokenResponse.ok) throw responseError(tokenResponse, tokenBody);
  const token = tokenBody?.token;
  const downloadUrl = tokenBody?.downloadUrl;
  const tokenHeader = tokenBody?.tokenHeader;
  if (
    typeof token !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(token)
    || typeof downloadUrl !== "string"
    || downloadUrl !== `/api/project-exports/${operation.id}/download`
    || tokenHeader !== "x-export-download-token"
  ) throw new ProjectExportClientError("invalid_response", tokenResponse.status);

  let downloadResponse: Response;
  try {
    downloadResponse = await fetcher(downloadUrl, {
      headers: { "x-export-download-token": token },
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ProjectExportClientError("network");
  }
  if (!downloadResponse.ok) {
    const body = await responseBody(downloadResponse);
    throw responseError(downloadResponse, body);
  }
  return { blob: await downloadResponse.blob(), fileName: operation.artifact.fileName };
}

export function parseExportAuthorOptions(value: unknown): ExportFilterOption[] | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.members)) return null;
  const result: ExportFilterOption[] = [];
  const seen = new Set<string>();
  for (const item of value.members) {
    if (!isRecord(item)) return null;
    if (item.name == null) continue;
    if (typeof item.name !== "string") return null;
    const name = item.name.trim();
    const key = name.toLocaleLowerCase("ru-RU");
    if (name && !seen.has(key)) {
      seen.add(key);
      result.push({ value: name, label: name });
    }
  }
  return result;
}

export function parseExportCampaignOptions(value: unknown): ExportFilterOption[] | null {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.campaigns)) return null;
  const result: ExportFilterOption[] = [];
  const seen = new Set<string>();
  for (const item of value.campaigns) {
    if (!isRecord(item) || typeof item.goal !== "string") return null;
    const goal = item.goal.trim();
    const key = goal.toLocaleLowerCase("ru-RU");
    if (goal && !seen.has(key)) {
      seen.add(key);
      result.push({ value: goal, label: goal });
    }
  }
  return result;
}
