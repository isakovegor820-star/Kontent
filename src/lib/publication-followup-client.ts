export type PublicationExtraView = {
  id: number;
  kind: "first_comment" | "configure_comments" | "pin" | "unpin";
  status: string;
  fingerprint: string;
  attempts: number;
  error: string | null;
  message: string | null;
  externalUrl: string | null;
};

export type PublicationReviewView = {
  id: number;
  responsibleUserId: number;
  reviewAt: string;
  timezone: string;
  status: "scheduled" | "due" | "completed" | "cancelled";
  decision: "keep" | "update" | "unpin" | "remove_manually" | null;
  reminderStatus: string;
  version: number;
  updateDraftId: number | null;
  canDecide: boolean;
  canUnpin: boolean;
};

export type PublicationReviewDecisionResponse = {
  draftId: number | null;
};

export type PublicationDestinationFollowup = {
  postId: number;
  network: string;
  title: string | null;
  extraOperations: PublicationExtraView[];
  review: PublicationReviewView | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positive(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function strictPositiveNumber(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function parseExtra(value: unknown): PublicationExtraView | null {
  const item = record(value);
  const id = positive(item?.id);
  const attempts = Number(item?.attempts);
  const kind = String(item?.kind || "") as PublicationExtraView["kind"];
  const fingerprint = String(item?.fingerprint || "");
  if (
    id == null || !["first_comment", "configure_comments", "pin", "unpin"].includes(kind)
    || typeof item?.status !== "string" || !/^[0-9a-f]{64}$/u.test(fingerprint)
    || !Number.isSafeInteger(attempts) || attempts < 0
  ) return null;
  return {
    id,
    kind,
    status: item.status,
    fingerprint,
    attempts,
    error: typeof item.error === "string" ? item.error : null,
    message: typeof item.message === "string" ? item.message : null,
    externalUrl: typeof item.externalUrl === "string" ? item.externalUrl : null,
  };
}

function parseReview(value: unknown): PublicationReviewView | null {
  if (value == null) return null;
  const item = record(value);
  const id = positive(item?.id);
  const responsibleUserId = positive(item?.responsibleUserId);
  const version = positive(item?.version);
  const status = String(item?.status || "") as PublicationReviewView["status"];
  const decision = item?.decision == null ? null : String(item.decision) as PublicationReviewView["decision"];
  const reviewAt = String(item?.reviewAt || "");
  const hasUpdateDraftId = item != null
    && Object.prototype.hasOwnProperty.call(item, "updateDraftId");
  const updateDraftId = item?.updateDraftId === null
    ? null
    : strictPositiveNumber(item?.updateDraftId);
  if (
    id == null || responsibleUserId == null || version == null
    || !["scheduled", "due", "completed", "cancelled"].includes(status)
    || (decision != null && !["keep", "update", "unpin", "remove_manually"].includes(decision))
    || Number.isNaN(new Date(reviewAt).getTime())
    || typeof item?.timezone !== "string" || !item.timezone
    || typeof item?.reminderStatus !== "string"
    || !hasUpdateDraftId
    || (item?.updateDraftId !== null && updateDraftId == null)
    || typeof item?.canDecide !== "boolean"
    || typeof item?.canUnpin !== "boolean"
    || (item.canUnpin && !item.canDecide)
  ) return null;
  return {
    id,
    responsibleUserId,
    reviewAt,
    timezone: item.timezone,
    status,
    decision,
    reminderStatus: item.reminderStatus,
    version,
    updateDraftId,
    canDecide: item.canDecide,
    canUnpin: item.canUnpin,
  };
}

export function parsePublicationReviewDecisionResponse(
  value: unknown,
): PublicationReviewDecisionResponse | null {
  const body = record(value);
  if (
    body?.ok !== true
    || !Object.prototype.hasOwnProperty.call(body, "draftId")
  ) return null;
  if (body.draftId === null) return { draftId: null };
  const draftId = strictPositiveNumber(body.draftId);
  return draftId == null ? null : { draftId };
}

export function parsePublicationFollowupResponse(value: unknown): PublicationDestinationFollowup[] | null {
  const body = record(value);
  const operation = record(body?.operation);
  if (body?.ok !== true || !Array.isArray(operation?.destinations)) return null;
  const destinations: PublicationDestinationFollowup[] = [];
  for (const raw of operation.destinations) {
    const item = record(raw);
    const postId = positive(item?.postId);
    if (postId == null || typeof item?.network !== "string" || !Array.isArray(item.extraOperations)) return null;
    const extras = item.extraOperations.map(parseExtra);
    if (extras.some((extra) => extra == null)) return null;
    const review = parseReview(item.review);
    if (item.review != null && review == null) return null;
    destinations.push({
      postId,
      network: item.network,
      title: typeof item.title === "string" ? item.title : null,
      extraOperations: extras as PublicationExtraView[],
      review,
    });
  }
  return destinations;
}

export const PUBLICATION_EXTRA_LABELS: Record<PublicationExtraView["kind"], string> = {
  first_comment: "Первый комментарий",
  configure_comments: "Настройка комментариев",
  pin: "Закрепление",
  unpin: "Открепление",
};

export function publicationExtraStatus(value: PublicationExtraView) {
  if (value.status === "succeeded") return { label: "Выполнено", tone: "success" as const };
  if (value.status === "unsupported") return { label: "Недоступно для площадки", tone: "neutral" as const };
  if (value.status === "failed") return { label: "Нужно проверить", tone: "danger" as const };
  if (["pending", "dispatching", "queued", "running", "waiting_dependency", "failed_retry"].includes(value.status)) {
    return { label: "В работе", tone: "pending" as const };
  }
  return { label: "Не выполняется", tone: "neutral" as const };
}

export function publicationFollowupError(value: unknown) {
  const body = record(value);
  const error = String(body?.error || "");
  if (error === "provider_confirmation_required") {
    return "Перед повтором подтвердите, что комментария действительно нет во внешнем канале.";
  }
  if (error === "version_conflict") return "Задача уже изменилась. Обновите данные и повторите.";
  if (error === "forbidden") return "Недостаточно прав для этого действия.";
  if (error === "operation_not_retryable") return "Действие уже выполняется или завершено.";
  if (error === "review_update_draft_missing") {
    return "Решение могло сохраниться, но черновик не получен. Обновите статусы и повторите открытие черновика.";
  }
  return "Действие не выполнено. Состояние публикации не изменилось — попробуйте ещё раз.";
}
