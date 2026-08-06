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
