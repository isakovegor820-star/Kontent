import {
  BRAND_DICTIONARY_ENTRY_KINDS,
  type BrandDictionaryEntryKind,
} from "./legal-typographer";

export type ClientBrandDictionaryEntry = {
  id: number;
  kind: BrandDictionaryEntryKind;
  term: string;
  replacement: string | null;
  expansion: string | null;
  caseSensitive: boolean;
  version: number;
};

export type ClientBrandDictionary = {
  projectId: number;
  version: number;
  entries: ClientBrandDictionaryEntry[];
  updatedAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value == null) return null;
  return typeof value === "string" ? value : undefined;
}

function parseEntry(value: unknown): ClientBrandDictionaryEntry | null {
  if (!isRecord(value)) return null;
  const id = positiveInteger(value.id);
  const version = positiveInteger(value.version);
  const kind = String(value.kind ?? "") as BrandDictionaryEntryKind;
  const replacement = nullableString(value.replacement);
  const expansion = nullableString(value.expansion);
  if (
    !id
    || !version
    || !BRAND_DICTIONARY_ENTRY_KINDS.includes(kind)
    || typeof value.term !== "string"
    || !value.term
    || replacement === undefined
    || expansion === undefined
    || typeof value.caseSensitive !== "boolean"
  ) return null;
  return {
    id,
    version,
    kind,
    term: value.term,
    replacement,
    expansion,
    caseSensitive: value.caseSensitive,
  };
}

export function parseBrandDictionaryResponse(value: unknown): ClientBrandDictionary | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.dictionary)) return null;
  const dictionary = value.dictionary;
  const projectId = positiveInteger(dictionary.projectId);
  const version = positiveInteger(dictionary.version);
  const updatedAt = nullableString(dictionary.updatedAt);
  if (!projectId || !version || updatedAt === undefined || !Array.isArray(dictionary.entries)) return null;
  const entries = dictionary.entries.map(parseEntry);
  if (!entries.every((entry): entry is ClientBrandDictionaryEntry => entry !== null)) return null;
  return { projectId, version, entries, updatedAt };
}

export async function loadBrandDictionary(signal?: AbortSignal): Promise<ClientBrandDictionary> {
  const response = await fetch("/api/brand-dictionary", { cache: "no-store", signal });
  const body = await response.json().catch(() => null);
  const dictionary = response.ok ? parseBrandDictionaryResponse(body) : null;
  if (!dictionary) {
    const code = isRecord(body) && typeof body.error === "string" ? body.error : "network";
    throw new Error(code);
  }
  return dictionary;
}

export function brandDictionaryErrorMessage(code: unknown) {
  switch (code) {
    case "invalid_kind": return "Выбери тип правила.";
    case "invalid_term": return "Укажи термин длиной до 240 символов без служебных знаков.";
    case "invalid_replacement": return "Укажи каноничную замену длиной до 240 символов.";
    case "invalid_expansion": return "Проверь расшифровку: не более 500 символов.";
    case "duplicate_term": return "Такое правило этого типа уже есть в словаре.";
    case "version_conflict": return "Словарь изменился в другой вкладке. Данные обновлены — повтори действие.";
    case "entry_not_found": return "Правило уже удалено. Словарь обновлён.";
    case "access_denied": return "Недостаточно прав для изменения словаря проекта.";
    case "unauthorized": return "Сессия истекла. Войди в аккаунт снова.";
    case "rate_limited": return "Слишком много изменений. Подожди и повтори действие.";
    case "rate_limit_unavailable": return "Проверка частоты запросов недоступна. Повтори позже.";
    default: return "Не удалось сохранить словарь. Проверь соединение и повтори попытку.";
  }
}
