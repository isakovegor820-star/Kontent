import { describe, expect, it } from "vitest";

import {
  STUDIO_RESEARCH_MAX_LABEL,
  STUDIO_RESEARCH_MAX_SOURCES,
  parseStudioResearchHeaders,
  parseStudioResearchStatus,
  studioResearchCountsLine,
  studioResearchProgressLabel,
} from "./studio-research-view";

/** Заголовок сервера: URI-encoded JSON, как его отдаёт /api/ai/generate. */
function header(payload: unknown): string {
  return encodeURIComponent(JSON.stringify(payload));
}

const valid = {
  used: true,
  reason: "Запрос на пост по внешней теме, Событие во внешнем мире",
  queries: 3,
  pages: 5,
  findings: 4,
  sources: [
    { label: "OpenAI", url: "https://openai.com/index/new-model", date: "2026-09-30", tier: "Отраслевой источник" },
    { label: "Ведомости", url: "http://www.vedomosti.ru/tech/news/1", date: null, tier: "СМИ" },
  ],
};

describe("studio research headers", () => {
  it("не показывает ничего, когда исследования не было", () => {
    expect(parseStudioResearchHeaders(null, null)).toBeNull();
    expect(parseStudioResearchHeaders("none", null)).toBeNull();
    expect(parseStudioResearchHeaders("", "")).toBeNull();
    // Неизвестный статус трактуем как «не ходили» — молчание безопаснее выдумки.
    expect(parseStudioResearchHeaders("weird", null)).toBeNull();
    expect(parseStudioResearchStatus("none")).toBe("none");
    expect(parseStudioResearchStatus("OK")).toBe("ok");
    expect(parseStudioResearchStatus(42)).toBe("none");
  });

  it("разбирает валидный заголовок и переносит источники в модель показа", () => {
    const view = parseStudioResearchHeaders("ok", header(valid));
    expect(view).not.toBeNull();
    expect(view?.status).toBe("ok");
    expect(view?.used).toBe(true);
    expect(view?.reason).toContain("внешней теме");
    expect(view?.queries).toBe(3);
    expect(view?.pages).toBe(5);
    expect(view?.findings).toBe(4);
    expect(view?.nothingVerified).toBe(false);
    expect(view?.sources).toHaveLength(2);
    expect(view?.sources[0]).toEqual({
      label: "OpenAI",
      url: "https://openai.com/index/new-model",
      date: "30.09.2026",
      tier: "Отраслевой источник",
    });
    expect(view?.sources[1]?.date).toBeNull();
    expect(view?.countsLine).toBe("Запросов: 3 · Страниц: 5 · Подтверждённых фактов: 4");
  });

  it("переносит дату публикации без сдвига на часовой пояс и отбрасывает мусор", () => {
    const view = parseStudioResearchHeaders("ok", header({
      used: true,
      findings: 4,
      sources: [
        { label: "Дата", url: "https://a.example/1", date: "2026-09-30" },
        { label: "ISO", url: "https://a.example/2", date: "2026-09-30T21:45:00.000Z" },
        { label: "Не дата", url: "https://a.example/3", date: "вчера" },
        { label: "Несуществующая", url: "https://a.example/4", date: "2026-02-31" },
        { label: "Число", url: "https://a.example/5", date: 20260930 },
        { label: "Пусто", url: "https://a.example/6", date: "" },
      ],
    }));
    expect(view?.sources.map((source) => source.date)).toEqual([
      "30.09.2026",
      "30.09.2026",
      null,
      null,
      null,
      null,
    ]);
  });

  it("не падает на битом JSON, не-объекте и обрезанном значении", () => {
    expect(parseStudioResearchHeaders("ok", "{не json")).toMatchObject({ status: "ok", used: true, findings: 0 });
    expect(parseStudioResearchHeaders("ok", "[1,2,3]")).toMatchObject({ used: true, sources: [] });
    expect(parseStudioResearchHeaders("ok", "\"строка\"")).toMatchObject({ used: true, sources: [] });
    expect(parseStudioResearchHeaders("ok", "%E0%A4%A")).toMatchObject({ used: true, sources: [] });
    expect(parseStudioResearchHeaders("ok", `%${"A".repeat(70_000)}`)).toMatchObject({ used: true, sources: [] });
    expect(parseStudioResearchHeaders("empty", "null")).toMatchObject({ status: "empty", used: true, nothingVerified: true });
  });

  it("игнорирует поля с чужими типами вместо исключения", () => {
    const view = parseStudioResearchHeaders("ok", header({
      used: "да",
      reason: { text: "нет" },
      queries: "много",
      pages: Number.POSITIVE_INFINITY,
      findings: -7,
      sources: {
        0: { label: "OpenAI", url: "https://openai.com" },
      },
    }));
    expect(view).toMatchObject({ status: "ok", used: true, queries: 0, pages: 0, findings: 0, sources: [] });
    expect(view?.reason).toBe("");
    expect(view?.nothingVerified).toBe(true);
  });

  it("оставляет только http(s)-ссылки и требует строку вместо элемента списка", () => {
    const view = parseStudioResearchHeaders("ok", header({
      used: true,
      findings: 3,
      sources: [
        { label: "OpenAI", url: "https://openai.com/index/1" },
        { label: "JS", url: "javascript:alert(1)" },
        { label: "Файл", url: "file:///etc/passwd" },
        { label: "Почта", url: "mailto:hi@example.com" },
        { label: "Без схемы", url: "openai.com/index/2" },
        { label: "Пусто", url: "" },
        { label: "Не объект", url: 42 },
        "просто строка",
        null,
      ],
    }));
    expect(view?.sources).toHaveLength(1);
    expect(view?.sources[0]?.url).toBe("https://openai.com/index/1");
  });

  it("ограничивает список восемью источниками и обрезает длинные подписи", () => {
    const longLabel = "О".repeat(500);
    const view = parseStudioResearchHeaders("ok", header({
      used: true,
      queries: 12,
      pages: 20,
      findings: 9,
      // Больше восьми источников сервер в этот заголовок и не положит: список
      // обязан схлопнуться до выжимки, а не вываливать в чат весь журнал.
      sources: Array.from({ length: 24 }, (_, index) => ({
        label: longLabel,
        url: `https://example.com/page/${index}`,
        date: "2026-09-30",
        tier: "СМИ",
      })),
    }));
    expect(view?.sources).toHaveLength(STUDIO_RESEARCH_MAX_SOURCES);
    expect(view?.sources[0]?.label).toHaveLength(STUDIO_RESEARCH_MAX_LABEL);
    expect(view?.sources.at(-1)?.label).toHaveLength(STUDIO_RESEARCH_MAX_LABEL);
  });

  it("честно сообщает, что поиск был, но подтверждённых фактов нет", () => {
    const view = parseStudioResearchHeaders("empty", header({
      used: true,
      reason: "Событие во внешнем мире",
      queries: 4,
      pages: 9,
      findings: 0,
      sources: [],
    }));
    expect(view?.status).toBe("empty");
    expect(view?.used).toBe(true);
    expect(view?.nothingVerified).toBe(true);
    expect(view?.sources).toEqual([]);
    expect(view?.countsLine).toBe("Запросов: 4 · Страниц: 9 · Подтверждённых фактов: 0");
  });

  it("различает сбой поиска и пустую выдачу", () => {
    // Авария 02.10.2026: падение поиска показывалось как «искала, но не нашла»
    // при нуле запросов. Это разные сообщения и разные действия пользователя.
    const failed = parseStudioResearchHeaders("failed", header({
      used: true,
      reason: "Вопрос о внешнем предмете",
      queries: 0,
      pages: 0,
      findings: 0,
      sources: [],
    }));
    expect(failed?.status).toBe("failed");
    expect(failed?.failed).toBe(true);
    expect(failed?.nothingVerified).toBe(false);

    const empty = parseStudioResearchHeaders("empty", header({
      used: true,
      queries: 4,
      pages: 9,
      findings: 0,
      sources: [],
    }));
    expect(empty?.status).toBe("empty");
    expect(empty?.failed).toBe(false);
    expect(empty?.nothingVerified).toBe(true);
  });

  it("не обещает прогресс, когда поиск уже упал", () => {
    const failed = parseStudioResearchHeaders("failed", header({ used: true, queries: 0, pages: 0, findings: 0, sources: [] }));
    expect(studioResearchProgressLabel(failed, { streaming: true, hasText: false })).toBeNull();
  });

  it("строит строку счёта и русские формы числительных", () => {
    expect(studioResearchCountsLine(1, 1, 1)).toBe("Запросов: 1 · Страниц: 1 · Подтверждённых фактов: 1");
    expect(studioResearchCountsLine("2", undefined, null)).toBe("Запросов: 2 · Страниц: 0 · Подтверждённых фактов: 0");
  });

  it("показывает прогресс только пока текста нет и стрим идёт", () => {
    const view = parseStudioResearchHeaders("ok", header(valid));
    expect(studioResearchProgressLabel(view, { streaming: true, hasText: false })).toBe("Аврора смотрит в интернет…");
    expect(studioResearchProgressLabel(view, { hasText: false })).toBe("Аврора смотрит в интернет…");
    expect(studioResearchProgressLabel(view, { streaming: true, hasText: true })).toBeNull();
    expect(studioResearchProgressLabel(view, { streaming: false, hasText: false })).toBeNull();
    expect(studioResearchProgressLabel(null, { streaming: true })).toBeNull();
    const none = parseStudioResearchHeaders("none", null);
    expect(studioResearchProgressLabel(none, { streaming: true, hasText: false })).toBeNull();
  });
});
