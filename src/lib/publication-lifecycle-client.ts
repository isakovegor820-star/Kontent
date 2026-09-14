export type PublicationLifecycleResponse = {
  ok: boolean;
  error?: string;
  operationId?: number;
  status?: string;
  operationStatus?: string;
  scheduleRevision?: number;
  currentRevision?: number;
  currentStatus?: string;
  scheduledAt?: string;
  draftId?: number;
  draftVersion?: number;
};

export type PublicationOperationEditorContext = {
  operationId: number;
  draftId: number | null;
  draftVersion: number;
  status: string;
  scheduledAt: string;
  timezone: string;
  scheduleRevision: number;
  scheduleOffset: string | null;
  scheduleDisambiguation: "reject" | "earlier" | "later";
  destinations: Array<{
    postId: number;
    postStatus: string;
  }>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parsePublicationOperationEditorContext(
  value: unknown,
): PublicationOperationEditorContext | null {
  const body = record(value);
  const operation = record(body?.operation);
  const operationId = positiveInteger(operation?.id);
  const draftId = operation?.draftId == null ? null : positiveInteger(operation.draftId);
  const draftVersion = positiveInteger(operation?.draftVersion);
  const scheduleRevision = positiveInteger(operation?.scheduleRevision);
  const scheduledAt = typeof operation?.scheduledAt === "string" ? operation.scheduledAt : "";
  const disambiguation = operation?.scheduleDisambiguation;
  if (
    body?.ok !== true
    || operationId == null
    || (operation?.draftId != null && draftId == null)
    || draftVersion == null
    || scheduleRevision == null
    || typeof operation?.status !== "string"
    || !operation.status
    || !scheduledAt
    || Number.isNaN(Date.parse(scheduledAt))
    || typeof operation?.timezone !== "string"
    || !operation.timezone
    || (operation?.scheduleOffset != null && typeof operation.scheduleOffset !== "string")
    || !["reject", "earlier", "later"].includes(String(disambiguation))
    || !Array.isArray(operation?.destinations)
  ) return null;

  const destinations = operation.destinations.map((value) => {
    const destination = record(value);
    const postId = positiveInteger(destination?.postId);
    return postId != null && typeof destination?.postStatus === "string"
      ? { postId, postStatus: destination.postStatus }
      : null;
  });
  if (destinations.some((destination) => destination == null)) return null;

  return {
    operationId,
    draftId,
    draftVersion,
    status: operation.status,
    scheduledAt,
    timezone: operation.timezone,
    scheduleRevision,
    scheduleOffset: operation.scheduleOffset == null ? null : operation.scheduleOffset as string,
    scheduleDisambiguation: disambiguation as PublicationOperationEditorContext["scheduleDisambiguation"],
    destinations: destinations as PublicationOperationEditorContext["destinations"],
  };
}

export async function getPublicationOperationEditorContext(
  operationId: number,
  signal?: AbortSignal,
): Promise<PublicationOperationEditorContext> {
  const response = await fetch(`/api/publication-operations/${operationId}`, {
    cache: "no-store",
    signal,
  });
  const body = await response.json().catch(() => null);
  const parsed = parsePublicationOperationEditorContext(body);
  if (!response.ok || !parsed) throw new Error("publication_operation_unavailable");
  return parsed;
}

const SETTLED_PUBLICATION_STATUSES = new Set([
  "published",
  "published_unverified",
  "missing",
  "deleted_external",
]);

export function publicationOperationIsSettled(
  operation: PublicationOperationEditorContext,
): boolean {
  return operation.destinations.some((destination) => (
    SETTLED_PUBLICATION_STATUSES.has(destination.postStatus)
  ));
}

export function publicationEditorMutationKind(
  operation: PublicationOperationEditorContext,
  draftId: number,
  draftVersion: number,
): "reschedule" | "replace" | "clone_required" {
  const sameRevision = operation.draftId === draftId && operation.draftVersion === draftVersion;
  if (!sameRevision) return "replace";
  return publicationOperationIsSettled(operation) ? "clone_required" : "reschedule";
}

async function mutation(url: string, init: RequestInit): Promise<PublicationLifecycleResponse> {
  try {
    const response = await fetch(url, init);
    const body = (await response.json().catch(() => null)) as PublicationLifecycleResponse | null;
    if (body) return { ...body, ok: response.ok && body.ok === true };
    return { ok: false, error: "invalid_response" };
  } catch {
    return { ok: false, error: "network" };
  }
}

const headers = (idempotencyKey: string) => ({
  "content-type": "application/json",
  "idempotency-key": idempotencyKey,
});

export function cancelPublication(input: {
  operationId: number;
  expectedScheduleRevision: number;
  expectedStatus: string;
  idempotencyKey: string;
}) {
  return mutation(`/api/publication-operations/${input.operationId}`, {
    method: "DELETE",
    headers: headers(input.idempotencyKey),
    body: JSON.stringify({
      expectedScheduleRevision: input.expectedScheduleRevision,
      expectedStatus: input.expectedStatus,
    }),
  });
}

export function reschedulePublication(input: {
  operationId: number;
  expectedScheduleRevision: number;
  expectedStatus: string;
  idempotencyKey: string;
  scheduledAt: string;
  localDate: string;
  localTime: string;
  timezone: string;
  disambiguation: "reject" | "earlier" | "later";
  offset: string;
}) {
  return mutation(`/api/publication-operations/${input.operationId}`, {
    method: "PATCH",
    headers: headers(input.idempotencyKey),
    body: JSON.stringify({
      action: "reschedule",
      expectedScheduleRevision: input.expectedScheduleRevision,
      expectedStatus: input.expectedStatus,
      scheduledAt: input.scheduledAt,
      localDate: input.localDate,
      localTime: input.localTime,
      timezone: input.timezone,
      disambiguation: input.disambiguation,
      offset: input.offset,
    }),
  });
}

export function restorePublicationToDraft(input: {
  operationId: number;
  expectedScheduleRevision: number;
  expectedStatus: string;
  idempotencyKey: string;
}) {
  return mutation(`/api/publication-operations/${input.operationId}/restore-draft`, {
    method: "POST",
    headers: headers(input.idempotencyKey),
    body: JSON.stringify({
      expectedScheduleRevision: input.expectedScheduleRevision,
      expectedStatus: input.expectedStatus,
    }),
  });
}
