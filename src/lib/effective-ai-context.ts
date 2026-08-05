export type ProfileField = "niche" | "topics" | "services" | "prices" | "audience" | "tone" | "taboos" | "goal";
export type ProfileSourceKind = "verified_brief" | "profile_edit" | "profile" | "settings";

export interface ProfileCandidate {
  id: string;
  kind: ProfileSourceKind;
  fields: Partial<Record<ProfileField, string>>;
  verified: boolean;
  ready: boolean;
  updatedAt?: string;
}

export interface EffectiveProfileField {
  value: string;
  sourceId: string;
  sourceKind: ProfileSourceKind;
  verified: boolean;
}

export type EffectiveProfile = Partial<Record<ProfileField, EffectiveProfileField>>;

const PROFILE_FIELDS: ProfileField[] = ["niche", "topics", "services", "prices", "audience", "tone", "taboos", "goal"];

const STORED_PROFILE_LABELS: Array<[ProfileField, string]> = [
  ["niche", "Ниша канала:"],
  ["goal", "Цель канала:"],
  ["topics", "Основные темы канала:"],
  ["services", "Услуги и продукты:"],
  ["prices", "Цены и сроки:"],
  ["audience", "Аудитория канала:"],
  ["tone", "Тон общения автора:"],
  ["taboos", "О чём канал НЕ пишет и чего НЕ обещает:"],
];

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
}

/**
 * Не пытается решить «истинность» текста эвристикой. Отсекает только legacy-пустышки:
 * однообразные тестовые строки вроде «аоао / ава / аавоа» не должны вытеснять паспорт.
 */
export function hasUsableProfileValue(value: unknown): boolean {
  const text = clean(value);
  if (!text) return false;
  const letters = text.toLocaleLowerCase("ru").match(/\p{L}/gu) ?? [];
  if (letters.length < 4) return false;
  const distinct = new Set(letters).size;
  const words = text.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  if (letters.length < 12 && words.length < 2) return distinct >= 4;
  return distinct >= 5 || words.some((word) => word.length >= 8);
}

/** Reverse of channel-profile.profileToSourceText for field-wise source selection. */
export function profileFieldsFromStoredText(rawText: unknown): Partial<Record<ProfileField, string>> {
  const paragraphs = String(rawText ?? "").split(/\n\s*\n|\n/u).map((item) => item.trim()).filter(Boolean);
  const fields: Partial<Record<ProfileField, string>> = {};
  for (const [field, label] of STORED_PROFILE_LABELS) {
    const paragraph = paragraphs.find((item) => item.toLocaleLowerCase("ru").startsWith(label.toLocaleLowerCase("ru")));
    if (paragraph) fields[field] = clean(paragraph.slice(label.length));
  }
  return fields;
}

function priority(candidate: ProfileCandidate): number {
  if (candidate.kind === "profile_edit" && candidate.verified) return 500;
  if (candidate.kind === "verified_brief" && candidate.verified) return 400;
  if (candidate.kind === "profile") return candidate.verified ? 320 : 300;
  if (candidate.kind === "profile_edit") return 200;
  return 100;
}

/**
 * Выбирает профиль ПО ПОЛЯМ. Подтверждённая точечная правка перекрывает brief только
 * в своём поле; мусорная/неподтверждённая запись не стирает остальные хорошие данные.
 */
export function selectEffectiveProfile(candidates: ProfileCandidate[]): EffectiveProfile {
  const eligible = candidates
    .filter((candidate) => candidate.ready)
    .slice()
    .sort((a, b) => {
      const byPriority = priority(b) - priority(a);
      if (byPriority) return byPriority;
      return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
    });
  const result: EffectiveProfile = {};
  for (const field of PROFILE_FIELDS) {
    const candidate = eligible.find((item) => hasUsableProfileValue(item.fields[field]));
    if (!candidate) continue;
    result[field] = {
      value: clean(candidate.fields[field]),
      sourceId: candidate.id,
      sourceKind: candidate.kind,
      verified: candidate.verified,
    };
  }
  return result;
}

export type StyleSampleOrigin = "manual" | "aurora_published" | "rss" | "imported";
export type ExternalPublicationState = "present" | "missing" | "deleted" | "unknown";

export interface StyleSampleCandidate {
  id: string;
  text: string;
  origin: StyleSampleOrigin;
  manuallyApproved: boolean;
  externalState: ExternalPublicationState;
  publishedAt?: string;
}

export interface SelectedStyleSample {
  id: string;
  text: string;
  provenance: "manual_approved" | "externally_verified";
}

/**
 * Контракт для Gate 2: RSS/imported/stale записи не становятся голосом автора сами.
 * До появления external verification в запросе передавать unknown — helper fail-closed.
 */
export function selectStyleSamples(candidates: StyleSampleCandidate[], limit = 10): SelectedStyleSample[] {
  const safeLimit = Math.min(200, Math.max(1, Math.round(limit)));
  return candidates
    .filter((candidate) => clean(candidate.text).length >= 20)
    .map((candidate): SelectedStyleSample | null => {
      if (candidate.manuallyApproved) {
        return { id: candidate.id, text: clean(candidate.text), provenance: "manual_approved" };
      }
      if (candidate.origin === "aurora_published" && candidate.externalState === "present") {
        return { id: candidate.id, text: clean(candidate.text), provenance: "externally_verified" };
      }
      return null;
    })
    .filter((candidate): candidate is SelectedStyleSample => candidate !== null)
    .slice(0, safeLimit);
}
