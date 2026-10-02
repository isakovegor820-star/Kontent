// Чистая view-модель «журнала исследования интернета».
//
// Модуль не знает ни про сеть, ни про базу: он превращает строку запуска и
// сохранённые факты в то, что видит пользователь — сводку, список запросов,
// сгруппированные причины отказов и карточки с цитатами. Благодаря этому
// «полный лог исследования» проверяется тестом без единого запроса.

import { LEGAL_STATUS_LABELS, WEB_FINDING_KIND_LABELS, WEB_FINDING_REJECTION_LABELS } from "./web-research-contract.mjs";
import { WEB_SOURCE_TIER_LABELS } from "./web-research-sources.mjs";
import type { WebResearchRunRow, WebResearchStoredFinding } from "./web-research-store.mjs";

/** Коды отказов, которые возникают до ворот достоверности (чтение страницы, извлечение). */
const WEB_RESEARCH_EXTRA_REJECTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  fetch_failed: "Страница не открылась",
  unsupported_content_type: "Содержимое страницы не является текстом",
  extract_failed: "Не удалось извлечь утверждения",
  no_facts: "На странице нет утверждений по теме",
  duplicate: "Такой факт уже был найден",
  budget_exhausted: "Закончился бюджет исследования",
});

/** Человекочитаемые названия шагов журнала. */
const WEB_RESEARCH_STEP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  plan: "План",
  search: "Поиск",
  select: "Отбор страниц",
  read: "Чтение",
  extract: "Извлечение",
  gate: "Проверка",
  save: "Сохранение",
});

/** Конечные статусы запуска: в интерфейсе это отдельные формулировки, а не «идёт». */
const STATUS_LABELS: Readonly<Record<WebResearchRunRow["status"], string>> = Object.freeze({
  running: "Исследование идёт",
  completed: "Исследование завершено",
  failed: "Исследование прервано",
});

const MSK = "Europe/Moscow";

export type WebResearchQueryRow = {
  id: string;
  text: string;
  category: string;
  categoryLabel: string;
  siteScoped: boolean;
};

export type WebResearchRejectionGroup = {
  code: string;
  label: string;
  count: number;
  details: string[];
  domains: string[];
};

export type WebResearchSummary = {
  status: WebResearchRunRow["status"];
  statusLabel: string;
  queries: number;
  pages: number;
  candidates: number;
  findingsCount: number;
  rejectionsCount: number;
  spentSeconds: number | null;
  sentence: string;
};

export type WebResearchCitationRow = {
  fingerprint: string;
  kindLabel: string;
  claim: string;
  quote: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceDomain: string;
  tierLabel: string;
  authoritative: boolean;
  publishedAt: string;
  publishedLabel: string;
  legalStatusLabel: string | null;
  ageLabel: string | null;
};

function cleanText(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);
}

/** Русские формы числительных: 1 запрос, 2 запроса, 5 запросов. */
export function webResearchPlural(count: number, one: string, few: string, many: string): string {
  const value = Math.abs(Math.trunc(Number(count) || 0));
  const hundred = value % 100;
  if (hundred >= 11 && hundred <= 14) return many;
  const ten = value % 10;
  if (ten === 1) return one;
  if (ten >= 2 && ten <= 4) return few;
  return many;
}

export function webResearchCount(count: number, one: string, few: string, many: string): string {
  const value = Math.max(0, Math.trunc(Number(count) || 0));
  return `${value} ${webResearchPlural(value, one, few, many)}`;
}

export function webResearchStepLabel(step: unknown): string {
  const code = cleanText(step, 40);
  return WEB_RESEARCH_STEP_LABELS[code] || "Шаг";
}

export function webResearchRejectionLabel(code: unknown, fallback?: unknown): string {
  const key = cleanText(code, 60);
  return WEB_FINDING_REJECTION_LABELS[key] || WEB_RESEARCH_EXTRA_REJECTION_LABELS[key] || cleanText(fallback, 200) || "Причина не указана";
}

export function webResearchKindLabel(kind: unknown): string {
  const key = cleanText(kind, 40);
  return WEB_FINDING_KIND_LABELS[key as keyof typeof WEB_FINDING_KIND_LABELS] || "Факт";
}

export function webResearchTierLabel(tierLabel: unknown, tier: unknown): string {
  const stored = cleanText(tierLabel, 80);
  if (stored) return stored;
  const key = cleanText(tier, 20);
  return WEB_SOURCE_TIER_LABELS[key as keyof typeof WEB_SOURCE_TIER_LABELS] || WEB_SOURCE_TIER_LABELS.open;
}

export function webResearchLegalStatusLabel(finding: Pick<WebResearchStoredFinding, "kind" | "legalStatus" | "legalStatusLabel">): string | null {
  if (finding.kind !== "law") return null;
  const stored = cleanText(finding.legalStatusLabel, 120);
  if (stored) return stored;
  const key = cleanText(finding.legalStatus, 40);
  return LEGAL_STATUS_LABELS[key as keyof typeof LEGAL_STATUS_LABELS] || null;
}

export function webResearchDateLabel(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

export function webResearchTimeLabel(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString("ru-RU", { timeZone: MSK, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

export function webResearchAgeLabel(ageDays: unknown): string | null {
  const days = Math.max(0, Math.trunc(Number(ageDays) || 0));
  if (!Number.isFinite(Number(ageDays))) return null;
  return `Опубликовано ${webResearchCount(days, "день", "дня", "дней")} назад`;
}

export function webResearchQueryRows(run: WebResearchRunRow | null): WebResearchQueryRow[] {
  if (!run) return [];
  return (Array.isArray(run.queries) ? run.queries : [])
    .map((query, index) => ({
      id: cleanText(query?.id, 40) || `q${index + 1}`,
      text: cleanText(query?.text, 240),
      category: cleanText(query?.category, 40),
      categoryLabel: webResearchKindLabel(query?.category),
      siteScoped: query?.siteScoped === true,
    }))
    .filter((query) => query.text.length > 0);
}

function rejectionDetailText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return cleanText(value, 200);
  try {
    return cleanText(JSON.stringify(value), 200);
  } catch {
    return "";
  }
}

function pushRejection(
  groups: Map<string, WebResearchRejectionGroup>,
  input: { code: string; label: string; detail: string; domain: string },
): void {
  const code = input.code || "unknown";
  const group = groups.get(code) || { code, label: webResearchRejectionLabel(code, input.label), count: 0, details: [], domains: [] };
  group.count += 1;
  const detail = cleanText(input.detail, 200);
  if (detail && group.details.length < 3 && !group.details.includes(detail)) group.details.push(detail);
  const domain = cleanText(input.domain, 120);
  if (domain && group.domains.length < 4 && !group.domains.includes(domain)) group.domains.push(domain);
  groups.set(code, group);
}

/**
 * Полный список отказов. Сначала берём структурированный `stats.rejections`
 * (воркер сохраняет его рядом со сводкой), и только если его нет — собираем
 * причины из журнала: пользователь в любом случае обязан увидеть, что именно
 * Аврора отбросила и почему.
 */
export function webResearchRejectionGroups(run: WebResearchRunRow | null): WebResearchRejectionGroup[] {
  if (!run) return [];
  const groups = new Map<string, WebResearchRejectionGroup>();
  const stats = run.stats && typeof run.stats === "object" ? run.stats : {};
  const stored = (stats as Record<string, unknown>).rejections;

  if (Array.isArray(stored)) {
    for (const item of stored) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const code = cleanText(record.code, 60);
      pushRejection(groups, {
        code,
        label: cleanText(record.reason, 200),
        detail: cleanText(record.claim, 200) || rejectionDetailText(record.detail),
        domain: cleanText(record.domain, 120) || cleanText(record.url, 240),
      });
    }
  } else {
    for (const entry of Array.isArray(run.log) ? run.log : []) {
      if (cleanText(entry?.step, 40) !== "gate") continue;
      const detail = entry?.detail && typeof entry.detail === "object" ? (entry.detail as Record<string, unknown>) : {};
      const code = cleanText(detail.code, 60);
      if (!code) continue;
      pushRejection(groups, {
        code,
        label: cleanText(entry?.message, 200),
        detail: rejectionDetailText(detail.detail),
        domain: cleanText(detail.url, 240),
      });
    }
  }

  return [...groups.values()]
    .map((group) => ({ ...group, label: group.label || webResearchRejectionLabel(group.code) }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

export function webResearchSummary(run: WebResearchRunRow | null, findings: WebResearchStoredFinding[]): WebResearchSummary | null {
  if (!run) return null;
  const stats = run.stats && typeof run.stats === "object" ? (run.stats as Record<string, unknown>) : {};
  const number = (value: unknown): number => Math.max(0, Math.trunc(Number(value) || 0));
  const queries = number(stats.queries);
  const pages = number(stats.pages);
  const candidates = number(stats.candidates);
  const spentMs = Number(stats.spentMs);
  const spentSeconds = Number.isFinite(spentMs) && spentMs > 0 ? Math.max(1, Math.round(spentMs / 1_000)) : null;
  const rejectionsCount = run.rejectionsCount || webResearchRejectionGroups(run).reduce((total, group) => total + group.count, 0);
  const findingsCount = findings.length || run.findingsCount;

  const parts = [
    `Аврора выполнила ${webResearchCount(queries, "запрос", "запроса", "запросов")}`,
    `прочитала ${webResearchCount(pages, "страницу", "страницы", "страниц")}`,
    `проверила и приняла ${webResearchCount(findingsCount, "факт", "факта", "фактов")}`,
  ];
  if (rejectionsCount > 0) parts.push(`отклонила ${webResearchCount(rejectionsCount, "факт", "факта", "фактов")}`);
  if (candidates > 0) parts.push(`всего рассмотрела ${webResearchCount(candidates, "источник", "источника", "источников")}`);

  return {
    status: run.status,
    statusLabel: STATUS_LABELS[run.status] || STATUS_LABELS.running,
    queries,
    pages,
    candidates,
    findingsCount,
    rejectionsCount,
    spentSeconds,
    sentence: `${parts.join(", ")}.`,
  };
}

export function webResearchCitationRows(findings: WebResearchStoredFinding[]): WebResearchCitationRow[] {  return (Array.isArray(findings) ? findings : [])
    .filter((finding) => Boolean(finding) && cleanText(finding.claim, 600).length > 0)
    .map((finding) => ({
      fingerprint: cleanText(finding.fingerprint, 80),
      kindLabel: webResearchKindLabel(finding.kind),
      claim: cleanText(finding.claim, 600),
      quote: cleanText(finding.quote, 4_000),
      sourceTitle: cleanText(finding.source?.label, 300) || cleanText(finding.source?.domain, 253) || "Источник",
      sourceUrl: cleanText(finding.source?.url, 2_000),
      sourceDomain: cleanText(finding.source?.domain, 253),
      tierLabel: webResearchTierLabel(finding.source?.tierLabel, finding.source?.tier),
      authoritative: finding.trusted === true,
      publishedAt: String(finding.publishedAt ?? ""),
      publishedLabel: webResearchDateLabel(finding.publishedAt),
      legalStatusLabel: webResearchLegalStatusLabel(finding),
      ageLabel: webResearchAgeLabel(finding.ageDays),
    }));
}
