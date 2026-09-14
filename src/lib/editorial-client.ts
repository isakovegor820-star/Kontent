import type { ProjectRole } from "./project-permissions";

export type ClientEditorialState = "draft" | "in_review" | "changes_requested" | "approved";
export type ClientEditorialDecision = "approve" | "request_changes";

export type ClientEditorialSnapshot = {
  workflow: {
    draftId: number;
    projectId: number;
    state: ClientEditorialState;
    version: number;
    currentRevisionId: number;
    submittedRevisionId: number | null;
    approvedRevisionId: number | null;
    approvedContentHash: string | null;
    updatedAt: string;
  };
  currentRevision: {
    id: number;
    projectId: number;
    draftId: number;
    draftVersion: number;
    authorUserId: number;
    authorName: string;
    contentHash: string;
    createdAt: string;
  };
  request: {
    id: number;
    revisionId: number;
    contentHash: string;
    requestedByUserId: number;
    requestedByName: string;
    status: "open" | "approved" | "changes_requested" | "superseded";
    version: number;
    requestedAt: string;
    resolvedAt: string | null;
  } | null;
  comments: Array<{
    id: number;
    revisionId: number;
    contentHash: string;
    authorUserId: number;
    authorName: string;
    body: string;
    createdAt: string;
  }>;
  decisions: Array<{
    id: number;
    requestId: number;
    revisionId: number;
    contentHash: string;
    actorUserId: number;
    actorName: string;
    decision: ClientEditorialDecision;
    note: string | null;
    createdAt: string;
  }>;
};

export class EditorialRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "EditorialRequestError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function nullablePositiveInteger(value: unknown): number | null | undefined {
  return value == null ? null : positiveInteger(value) ?? undefined;
}

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return value;
}

function hash(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function displayName(value: unknown, userId: number): string {
  return typeof value === "string" && value.trim() ? value.trim() : `Участник ${userId}`;
}

export function parseEditorialSnapshotResponse(value: unknown): ClientEditorialSnapshot | null {
  const body = record(value);
  const source = record(body?.editorial);
  const workflow = record(source?.workflow);
  const revision = record(source?.currentRevision);
  const workflowDraftId = positiveInteger(workflow?.draftId);
  const workflowProjectId = positiveInteger(workflow?.projectId);
  const workflowVersion = positiveInteger(workflow?.version);
  const currentRevisionId = positiveInteger(workflow?.currentRevisionId);
  const submittedRevisionId = nullablePositiveInteger(workflow?.submittedRevisionId);
  const approvedRevisionId = nullablePositiveInteger(workflow?.approvedRevisionId);
  const workflowUpdatedAt = dateString(workflow?.updatedAt);
  const state = String(workflow?.state || "") as ClientEditorialState;
  const approvedContentHash = workflow?.approvedContentHash == null
    ? null
    : hash(workflow.approvedContentHash);

  const revisionId = positiveInteger(revision?.id);
  const revisionProjectId = positiveInteger(revision?.projectId);
  const revisionDraftId = positiveInteger(revision?.draftId);
  const draftVersion = positiveInteger(revision?.draftVersion);
  const authorUserId = positiveInteger(revision?.authorUserId);
  const contentHash = hash(revision?.contentHash);
  const revisionCreatedAt = dateString(revision?.createdAt);

  if (
    body?.ok !== true || !source || !workflow || !revision
    || workflowDraftId == null || workflowProjectId == null || workflowVersion == null
    || currentRevisionId == null || submittedRevisionId === undefined || approvedRevisionId === undefined
    || workflowUpdatedAt == null || !["draft", "in_review", "changes_requested", "approved"].includes(state)
    || (workflow.approvedContentHash != null && approvedContentHash == null)
    || revisionId == null || revisionProjectId == null || revisionDraftId == null
    || draftVersion == null || authorUserId == null || contentHash == null || revisionCreatedAt == null
    || workflowDraftId !== revisionDraftId || workflowProjectId !== revisionProjectId
    || currentRevisionId !== revisionId
    || !Array.isArray(source.comments) || !Array.isArray(source.decisions)
  ) return null;

  const requestSource = source.request == null ? null : record(source.request);
  let request: ClientEditorialSnapshot["request"] = null;
  if (requestSource) {
    const id = positiveInteger(requestSource.id);
    const requestRevisionId = positiveInteger(requestSource.revisionId);
    const requestedByUserId = positiveInteger(requestSource.requestedByUserId);
    const version = positiveInteger(requestSource.version);
    const requestedAt = dateString(requestSource.requestedAt);
    const resolvedAt = requestSource.resolvedAt == null ? null : dateString(requestSource.resolvedAt);
    const requestHash = hash(requestSource.contentHash);
    const status = String(requestSource.status || "") as NonNullable<ClientEditorialSnapshot["request"]>["status"];
    if (
      id == null || requestRevisionId == null || requestedByUserId == null || version == null
      || requestedAt == null || (requestSource.resolvedAt != null && resolvedAt == null)
      || requestHash == null || !["open", "approved", "changes_requested", "superseded"].includes(status)
    ) return null;
    request = {
      id,
      revisionId: requestRevisionId,
      contentHash: requestHash,
      requestedByUserId,
      requestedByName: displayName(requestSource.requestedByName, requestedByUserId),
      status,
      version,
      requestedAt,
      resolvedAt,
    };
  } else if (source.request != null) return null;

  const comments = source.comments.map((entry) => {
    const item = record(entry);
    const id = positiveInteger(item?.id);
    const itemRevisionId = positiveInteger(item?.revisionId);
    const authorId = positiveInteger(item?.authorUserId);
    const itemHash = hash(item?.contentHash);
    const createdAt = dateString(item?.createdAt);
    if (
      id == null || itemRevisionId == null || authorId == null || itemHash == null || createdAt == null
      || typeof item?.body !== "string" || !item.body.trim() || item.body.length > 4_000
    ) return null;
    return {
      id,
      revisionId: itemRevisionId,
      contentHash: itemHash,
      authorUserId: authorId,
      authorName: displayName(item.authorName, authorId),
      body: item.body,
      createdAt,
    };
  });
  const decisions = source.decisions.map((entry) => {
    const item = record(entry);
    const id = positiveInteger(item?.id);
    const requestId = positiveInteger(item?.requestId);
    const itemRevisionId = positiveInteger(item?.revisionId);
    const actorId = positiveInteger(item?.actorUserId);
    const itemHash = hash(item?.contentHash);
    const createdAt = dateString(item?.createdAt);
    const decision = String(item?.decision || "") as ClientEditorialDecision;
    const note = item?.note == null ? null : typeof item.note === "string" ? item.note : undefined;
    if (
      id == null || requestId == null || itemRevisionId == null || actorId == null
      || itemHash == null || createdAt == null || !["approve", "request_changes"].includes(decision)
      || note === undefined || (note != null && note.length > 4_000)
    ) return null;
    return {
      id,
      requestId,
      revisionId: itemRevisionId,
      contentHash: itemHash,
      actorUserId: actorId,
      actorName: displayName(item?.actorName, actorId),
      decision,
      note,
      createdAt,
    };
  });
  if (comments.some((item) => item == null) || decisions.some((item) => item == null)) return null;

  return {
    workflow: {
      draftId: workflowDraftId,
      projectId: workflowProjectId,
      state,
      version: workflowVersion,
      currentRevisionId,
      submittedRevisionId,
      approvedRevisionId,
      approvedContentHash,
      updatedAt: workflowUpdatedAt,
    },
    currentRevision: {
      id: revisionId,
      projectId: revisionProjectId,
      draftId: revisionDraftId,
      draftVersion,
      authorUserId,
      authorName: displayName(revision.authorName, authorUserId),
      contentHash,
      createdAt: revisionCreatedAt,
    },
    request,
    comments: comments as ClientEditorialSnapshot["comments"],
    decisions: decisions as ClientEditorialSnapshot["decisions"],
  };
}

async function responseBody(response: Response): Promise<Record<string, unknown> | null> {
  return record(await response.json().catch(() => null));
}

async function mutate(draftId: number, path: string, payload: Record<string, unknown>): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/drafts/${draftId}/editorial/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new EditorialRequestError("network", 0);
  }
  const body = await responseBody(response);
  if (!response.ok || body?.ok !== true) {
    throw new EditorialRequestError(
      typeof body?.error === "string" ? body.error : response.status === 429 ? "rate_limited" : "server",
      response.status,
    );
  }
}

export async function loadEditorialSnapshot(
  draftId: number,
  signal?: AbortSignal,
): Promise<ClientEditorialSnapshot> {
  let response: Response;
  try {
    response = await fetch(`/api/drafts/${draftId}/editorial`, {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new EditorialRequestError("network", 0);
  }
  const body = await responseBody(response);
  if (!response.ok) {
    throw new EditorialRequestError(
      typeof body?.error === "string" ? body.error : "server",
      response.status,
    );
  }
  const snapshot = parseEditorialSnapshotResponse(body);
  if (!snapshot) throw new EditorialRequestError("bad_response", response.status);
  return snapshot;
}

export function submitEditorialReview(draftId: number, snapshot: ClientEditorialSnapshot): Promise<void> {
  return mutate(draftId, "submit", {
    revisionId: snapshot.currentRevision.id,
    contentHash: snapshot.currentRevision.contentHash,
    workflowVersion: snapshot.workflow.version,
  });
}

export function addEditorialComment(
  draftId: number,
  snapshot: ClientEditorialSnapshot,
  body: string,
): Promise<void> {
  return mutate(draftId, "comments", {
    revisionId: snapshot.currentRevision.id,
    contentHash: snapshot.currentRevision.contentHash,
    body,
  });
}

export function decideEditorialReview(
  draftId: number,
  snapshot: ClientEditorialSnapshot,
  decision: ClientEditorialDecision,
  note: string | null,
): Promise<void> {
  if (!snapshot.request) throw new EditorialRequestError("stale_request", 409);
  return mutate(draftId, "decisions", {
    requestId: snapshot.request.id,
    requestVersion: snapshot.request.version,
    workflowVersion: snapshot.workflow.version,
    revisionId: snapshot.currentRevision.id,
    contentHash: snapshot.currentRevision.contentHash,
    decision,
    note,
  });
}

/**
 * A personal-project owner does not need a separate self-approval control. Clicking
 * “Add to calendar” is the explicit publication decision, while the server still gets
 * the same immutable revision lineage used by team approvals.
 */
export async function approvePersonalDraftForPublication(
  draftId: number,
  expectedDraftVersion: number,
): Promise<ClientEditorialSnapshot> {
  let current = await loadEditorialSnapshot(draftId);
  if (current.currentRevision.draftVersion !== expectedDraftVersion) {
    throw new EditorialRequestError("stale_revision", 409);
  }
  if (current.workflow.state === "draft" || current.workflow.state === "changes_requested") {
    await submitEditorialReview(draftId, current);
    current = await loadEditorialSnapshot(draftId);
  }
  if (current.workflow.state === "in_review") {
    await decideEditorialReview(draftId, current, "approve", null);
    current = await loadEditorialSnapshot(draftId);
  }
  if (
    current.workflow.state !== "approved"
    || current.workflow.currentRevisionId !== current.workflow.approvedRevisionId
    || current.currentRevision.draftVersion !== expectedDraftVersion
  ) {
    throw new EditorialRequestError("stale_workflow", 409);
  }
  return current;
}

export function editorialRoleCapabilities(role: ProjectRole | null | undefined) {
  return {
    canSubmit: role === "owner" || role === "author" || role === "approver",
    canReview: role === "owner" || role === "approver",
    readOnly: role === "publisher",
  };
}

export function editorialErrorMessage(error: unknown): string {
  const code = error instanceof EditorialRequestError
    ? error.code
    : error instanceof Error
      ? error.message
      : String(error || "server");
  switch (code) {
    case "stale_revision":
    case "stale_workflow":
    case "stale_request":
    case "review_open":
      return "Материал изменился в другой вкладке. Данные обновлены — проверьте текущую версию и повторите действие.";
    case "decision_note_required":
      return "Опишите, что нужно исправить, и повторите запрос правок.";
    case "bad_comment":
      return "Введите комментарий длиной до 4 000 символов.";
    case "forbidden":
    case "access_denied":
    case "permission_denied":
      return "Для этого действия нужна другая роль в проекте.";
    case "not_found":
      return "Черновик больше недоступен. Откройте его заново из календаря.";
    case "rate_limited":
      return "Слишком много действий подряд. Подождите и повторите.";
    case "rate_limit_unavailable":
      return "Проверка частоты действий временно недоступна. Текст не изменён — повторите позже.";
    case "network":
      return "Нет связи с сервером. Текст и введённый комментарий остались на экране.";
    default:
      return "Действие не выполнено. Текст и введённый комментарий сохранились — повторите.";
  }
}
