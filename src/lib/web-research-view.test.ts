import { describe, expect, it } from "vitest";

import {
  webResearchAgeLabel,
  webResearchCitationRows,
  webResearchCount,
  webResearchDateLabel,
  webResearchKindLabel,
  webResearchLegalStatusLabel,
  webResearchQueryRows,
  webResearchRejectionGroups,
  webResearchRejectionLabel,
  webResearchStepLabel,
  webResearchSummary,
  webResearchTierLabel,
} from "./web-research-view";
import type { WebResearchRunRow, WebResearchStoredFinding } from "./web-research-store.mjs";

function run(overrides: Partial<WebResearchRunRow> = {}): WebResearchRunRow {
  return {
    id: 41,
    triggerKind: "manual",
    topic: "юридическая практика договоры",
    categories: ["law"],
    language: "RU",
    status: "completed",
    planFingerprint: "wrp-1-2",
    queries: [],
    log: [],
    stats: {},
    findingsCount: 0,
    rejectionsCount: 0,
    startedAt: "2026-10-02T09:00:00.000Z",
    finishedAt: "2026-10-02T09:00:42.000Z",
    error: null,
    ...overrides,
  };
}

function finding(overrides: Partial<WebResearchStoredFinding> = {}): WebResearchStoredFinding {
  return {
    id: 1,
    runId: 41,
    fingerprint: "wf-abc-12",
    kind: "law",
    claim: "Законопроект внесён в Государственную Думу",
    quote: "Законопроект внесён в Государственную Думу и направлен в профильный комитет",
    title: "Карточка законопроекта",
    language: "RU",
    legalStatus: "bill_submitted",
    legalStatusLabel: "Законопроект внесён в Госдуму",
    source: {
      url: "https://sozd.duma.gov.ru/bill/123456-8",
      domain: "sozd.duma.gov.ru",
      label: "СОЗД Государственной Думы — законопроекты",
      tier: "official",
      tierLabel: "Официальный источник",
      trust: 95,
      registered: true,
    },
    publishedAt: "2026-09-28T10:00:00.000Z",
    retrievedAt: "2026-10-02T09:00:00.000Z",
    ageDays: 4,
    numbers: ["123456"],
    corroboratingDomains: [],
    corroborationCount: 0,
    trusted: true,
    status: "new",
    ...overrides,
  };
}

describe("web research rejections", () => {
  it("groups rejections from the stored stats by reason with examples", () => {
    const groups = webResearchRejectionGroups(run({
      stats: {
        rejections: [
          { code: "quote_not_in_source", domain: "rbc.ru", url: "https://rbc.ru/a", reason: "Цитата не найдена", claim: "Рынок вырос на 12%" },
          { code: "quote_not_in_source", domain: "vedomosti.ru", url: "https://vedomosti.ru/b", claim: "Рынок вырос на 15%" },
          { code: "stale_source", domain: "tass.ru", url: "https://tass.ru/c", claim: "Событие прошло в 2024 году" },
        ],
      },
    }));

    expect(groups.map((group) => group.code)).toEqual(["quote_not_in_source", "stale_source"]);
    expect(groups[0]).toMatchObject({ label: "Цитата не найдена в скачанном тексте источника", count: 2 });
    expect(groups[0].details).toEqual(["Рынок вырос на 12%", "Рынок вырос на 15%"]);
    expect(groups[0].domains).toEqual(["rbc.ru", "vedomosti.ru"]);
    expect(groups[1]).toMatchObject({ count: 1, label: "Источник устарел для этого типа факта" });
  });

  it("falls back to the gate log so the full research log is never empty", () => {
    const groups = webResearchRejectionGroups(run({
      rejectionsCount: 2,
      log: [
        { step: "plan", message: "План: 6 запросов", detail: null, at: "2026-10-02T09:00:00.000Z" },
        { step: "gate", message: "Отклонено на habr.com: Число из утверждения не найдено в источнике", detail: { url: "https://habr.com/ru/news/1", code: "number_not_in_source" }, at: "2026-10-02T09:00:10.000Z" },
        { step: "gate", message: "Отклонено на habr.com: Нет дословной цитаты из источника", detail: { url: "https://habr.com/ru/news/2", code: "missing_quote" }, at: "2026-10-02T09:00:11.000Z" },
      ],
    }));

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.code).sort()).toEqual(["missing_quote", "number_not_in_source"]);
    expect(groups.find((group) => group.code === "number_not_in_source")?.domains).toEqual(["https://habr.com/ru/news/1"]);
  });

  it("labels the pre-gate technical failures instead of showing raw codes", () => {
    expect(webResearchRejectionLabel("fetch_failed", "Страница не загрузилась")).toBe("Страница не открылась");
    expect(webResearchRejectionLabel("no_facts", "")).toBe("На странице нет утверждений по теме");
    expect(webResearchRejectionLabel("something_new", "Причина от сервера")).toBe("Причина от сервера");
    expect(webResearchRejectionLabel(null, null)).toBe("Причина не указана");
  });

  it("never doubles the rejection count and keeps an empty run honest", () => {
    expect(webResearchRejectionGroups(null)).toEqual([]);
    expect(webResearchSummary(null, [])).toBeNull();
    expect(webResearchSummary(run(), [])?.rejectionsCount).toBe(0);
  });
});

describe("web research summary", () => {
  it("describes the run in Russian with correct numeral forms", () => {
    const summary = webResearchSummary(run({
      stats: { queries: 6, pages: 12, candidates: 41, spentMs: 42_000 },
      findingsCount: 3,
      rejectionsCount: 5,
    }), [finding(), finding({ fingerprint: "wf-def-13" }), finding({ fingerprint: "wf-ghi-14" })]);

    expect(summary?.sentence).toBe(
      "Аврора выполнила 6 запросов, прочитала 12 страниц, проверила и приняла 3 факта, отклонила 5 фактов, всего рассмотрела 41 источник.",
    );
    expect(summary).toMatchObject({ statusLabel: "Исследование завершено", queries: 6, pages: 12, spentSeconds: 42 });
  });

  it("uses singular and few-forms for small runs", () => {
    expect(webResearchCount(1, "запрос", "запроса", "запросов")).toBe("1 запрос");
    expect(webResearchCount(2, "запрос", "запроса", "запросов")).toBe("2 запроса");
    expect(webResearchCount(11, "запрос", "запроса", "запросов")).toBe("11 запросов");
    expect(webResearchCount(21, "запрос", "запроса", "запросов")).toBe("21 запрос");
    expect(webResearchSummary(run({ stats: { queries: 1, pages: 1 }, findingsCount: 1 }), [finding({})])?.sentence)
      .toContain("прочитала 1 страницу");
  });

  it("never presents a failed run as a successful one", () => {
    const summary = webResearchSummary(run({ status: "failed", error: "search provider unavailable", stats: {} }), []);
    expect(summary?.statusLabel).toBe("Исследование прервано");
    expect(summary?.sentence).toBe("Аврора выполнила 0 запросов, прочитала 0 страниц, проверила и приняла 0 фактов.");
  });
});

describe("web research queries and citations", () => {
  it("marks site-scoped queries and translates their categories", () => {
    const rows = webResearchQueryRows(run({
      queries: [
        { id: "q1", text: "site:pravo.gov.ru законопроект изменения", category: "law", siteScoped: true },
        { id: "q2", text: "законопроект изменения 2026", category: "law", siteScoped: false },
        { id: "q3", text: "   ", category: "law", siteScoped: false },
      ],
    }));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "q1", siteScoped: true, categoryLabel: "Норма права" });
    expect(rows[1].siteScoped).toBe(false);
  });

  it("builds citation rows with source, tier, date and legal status", () => {
    const [row] = webResearchCitationRows([finding()]);
    expect(row).toMatchObject({
      kindLabel: "Норма права",
      sourceTitle: "СОЗД Государственной Думы — законопроекты",
      sourceUrl: "https://sozd.duma.gov.ru/bill/123456-8",
      tierLabel: "Официальный источник",
      legalStatusLabel: "Законопроект внесён в Госдуму",
      authoritative: true,
    });
    expect(row.publishedLabel).toMatch(/2026/);
    expect(row.ageLabel).toBe("Опубликовано 4 дня назад");
  });

  it("falls back to registry labels when the stored payload is thin", () => {
    const [row] = webResearchCitationRows([finding({
      kind: "statistics",
      legalStatus: null,
      legalStatusLabel: null,
      trusted: false,
      source: { url: "https://example.com/a", domain: "example.com", label: "", tier: "open", tierLabel: "", trust: 40, registered: false },
    })]);

    expect(row.kindLabel).toBe("Статистика");
    expect(row.sourceTitle).toBe("example.com");
    expect(row.tierLabel).toBe("Открытый источник");
    expect(row.legalStatusLabel).toBeNull();
    expect(row.authoritative).toBe(false);
  });

  it("derives the legal status label from the code for law findings only", () => {
    expect(webResearchLegalStatusLabel({ kind: "law", legalStatus: "in_force", legalStatusLabel: null })).toBe("Закон вступил в силу");
    expect(webResearchLegalStatusLabel({ kind: "market", legalStatus: "in_force", legalStatusLabel: null })).toBeNull();
    expect(webResearchLegalStatusLabel({ kind: "law", legalStatus: null, legalStatusLabel: null })).toBeNull();
  });

  it("keeps date, kind and step labels human readable in Russian", () => {
    expect(webResearchDateLabel("2026-09-28T10:00:00.000Z")).toContain("2026");
    expect(webResearchDateLabel("не дата")).toBe("");
    expect(webResearchAgeLabel(0)).toBe("Опубликовано 0 дней назад");
    expect(webResearchStepLabel("gate")).toBe("Проверка");
    expect(webResearchStepLabel("unknown")).toBe("Шаг");
    expect(webResearchKindLabel("benchmark")).toBe("Бенчмарк");
    expect(webResearchTierLabel("", "research")).toBe("Исследование");
  });
});
