export type TypographyRunResponse = {
  id: number;
  sourceText: string;
  resultText: string;
  dictionaryVersion: number;
  rulesVersion: string;
  rejectedSuggestionIds: string[];
  reviewComplete: boolean;
  currentReview: boolean;
  undone: boolean;
  duplicate: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRun(value: unknown): TypographyRunResponse | null {
  if (!isRecord(value)) return null;
  const id = Number(value.id);
  const dictionaryVersion = Number(value.dictionaryVersion);
  if (
    !Number.isSafeInteger(id)
    || id <= 0
    || !Number.isSafeInteger(dictionaryVersion)
    || dictionaryVersion <= 0
    || typeof value.sourceText !== "string"
    || typeof value.resultText !== "string"
    || typeof value.rulesVersion !== "string"
    || !Array.isArray(value.rejectedSuggestionIds)
    || value.rejectedSuggestionIds.some((entry) => typeof entry !== "string")
    || typeof value.reviewComplete !== "boolean"
    || (value.currentReview != null && typeof value.currentReview !== "boolean")
    || typeof value.undone !== "boolean"
    || typeof value.duplicate !== "boolean"
  ) return null;
  return {
    id,
    dictionaryVersion,
    sourceText: value.sourceText,
    resultText: value.resultText,
    rulesVersion: value.rulesVersion,
    rejectedSuggestionIds: value.rejectedSuggestionIds.slice(),
    reviewComplete: value.reviewComplete,
    currentReview: value.currentReview ?? value.reviewComplete,
    undone: value.undone,
    duplicate: value.duplicate,
  };
}

async function jsonRequest(url: string, init: RequestInit) {
  try {
    const response = await fetch(url, { cache: "no-store", ...init });
    const parsed = await response.json().catch(() => null);
    return { response, body: isRecord(parsed) ? parsed : null };
  } catch {
    return { response: null, body: null };
  }
}

export async function applyTypographyOnServer(input: {
  requestKey: string;
  draftId: number | null;
  text: string;
  expectedDictionaryVersion: number;
  acceptedSuggestionIds: "safe" | readonly string[];
  rejectedSuggestionIds?: readonly string[];
  formatQuotes: boolean;
}): Promise<TypographyRunResponse> {
  const { response, body } = await jsonRequest("/api/typography/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const run = response?.ok && body?.ok === true ? parseRun(body.run) : null;
  if (!run) {
    const code = typeof body?.error === "string" ? body.error : "network";
    throw new Error(code);
  }
  return run;
}

export async function undoTypographyOnServer(runId: number, currentText: string) {
  const { response, body } = await jsonRequest(`/api/typography/runs/${runId}/undo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentText }),
  });
  if (
    !response?.ok
    || body?.ok !== true
    || typeof body.text !== "string"
    || Number(body.runId) !== runId
  ) {
    const code = typeof body?.error === "string" ? body.error : "network";
    throw new Error(code);
  }
  return body.text;
}

export async function loadLatestTypographyRun(draftId: number, signal?: AbortSignal) {
  const { response, body } = await jsonRequest(
    `/api/typography/runs/latest?draftId=${encodeURIComponent(String(draftId))}`,
    { method: "GET", signal },
  );
  if (!response?.ok || body?.ok !== true) {
    const code = typeof body?.error === "string" ? body.error : "network";
    throw new Error(code);
  }
  if (body.run == null) return null;
  const run = parseRun(body.run);
  if (!run) throw new Error("invalid_response");
  return run;
}

export function typographyActionErrorMessage(code: unknown) {
  switch (code) {
    case "dictionary_version_conflict": return "Словарь изменился. Обнови правила и повтори действие.";
    case "stale_suggestions": return "Текст или набор правок изменился. Проверь предложения ещё раз.";
    case "current_text_mismatch": return "После типографа текст уже менялся, поэтому автоматическая отмена недоступна.";
    case "nothing_to_undo": return "В этой проверке текст не менялся.";
    case "access_denied": return "Недостаточно прав для изменения текста в этом проекте.";
    case "rate_limited": return "Слишком много проверок подряд. Подожди и повтори действие.";
    case "rate_limit_unavailable": return "Проверка частоты запросов недоступна. Повтори позже.";
    case "unauthorized": return "Сессия истекла. Войди в аккаунт снова.";
    default: return "Не удалось подтвердить правки на сервере. Текст не изменён.";
  }
}
