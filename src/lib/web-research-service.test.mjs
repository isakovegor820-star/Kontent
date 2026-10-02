import { describe, expect, it, vi } from "vitest";

import {
  isReadableResearchUrl,
  runWebResearch,
  selectResearchPages,
  summarizeWebResearchRun,
  webFindingAngle,
} from "./web-research-service.mjs";
import { planWebResearch, webResearchKeywords, webResearchTopic } from "./web-research-plan.mjs";
import { sourceTextFromHtml } from "./web-research-contract.mjs";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");

const LAW_PAGE_HTML = `<html><head><title>Новости права</title>
  <script>tracking()</script></head><body>
  <h1>Изменения в законодательстве</h1>
  <p>Федеральный закон от 30.09.2026 № 321-ФЗ вступает в силу с 1 марта 2027 года
  и сокращает число проверок на 40 процентов, сообщает официальный портал.</p>
  <p>Документ опубликован и доступен для ознакомления в полном объёме на портале
  правовой информации в разделе действующих нормативных актов.</p>
</body></html>`;

const LAW_DRAFT = {
  kind: "law",
  claim: "Федеральный закон вступает в силу с 1 марта 2027 года",
  quote: "вступает в силу с 1 марта 2027 года",
  legalStatus: "in_force",
  publishedAt: "2026-09-30T09:00:00.000Z",
};

function deps(overrides = {}) {
  return {
    now: NOW,
    search: vi.fn(async () => [
      { url: "https://publication.pravo.gov.ru/document/1", title: "Закон", snippet: "законопроект изменения" },
    ]),
    fetchPage: vi.fn(async () => ({
      url: "https://publication.pravo.gov.ru/document/1",
      status: 200,
      contentType: "text/html; charset=utf-8",
      html: LAW_PAGE_HTML,
    })),
    extract: vi.fn(async () => [LAW_DRAFT]),
    ...overrides,
  };
}

describe("план исследования", () => {
  it("без темы и запросов падает, а не ищет наугад", () => {
    expect(() => planWebResearch({})).toThrow(/нужна тема/u);
  });

  it("по умолчанию не использует оператор site:, которому движки не подчиняются", () => {
    // Замер: Bing RSS и DuckDuckGo HTML оператор игнорируют и возвращают статьи
    // о слове «site» — словари, Google Sites и казино-спам. Приоритетные site:-запросы
    // забивали пул кандидатов мусором, поэтому доверие к источнику теперь даёт реестр
    // доменов, а не оператор поиска.
    const plan = planWebResearch({ topic: "маркировка рекламы", categories: ["law"] });
    expect(plan.siteScopedCount).toBe(0);
    expect(plan.queries.every((query) => !query.siteScoped)).toBe(true);
    expect(plan.queries.length).toBeGreaterThan(0);
  });

  it("включает site:-запросы только по явной просьбе", () => {
    const plan = planWebResearch({ topic: "маркировка рекламы", categories: ["law"], includeScoped: true });
    const scoped = plan.queries.filter((query) => query.siteScoped);
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped[0].text).toMatch(/^site:/u);
  });

  it("не превышает бюджет запросов", () => {
    const plan = planWebResearch({ topic: "искусственный интеллект", categories: ["law", "benchmark"] }, {});
    expect(plan.queries.length).toBeLessThanOrEqual(plan.budget.maxQueries);
    expect(new Set(plan.queries.map((query) => query.text)).size).toBe(plan.queries.length);
  });

  it("уважает явно урезанный бюджет", () => {
    const plan = planWebResearch({ topic: "право и технологии", categories: ["law"], budget: { maxQueries: 2 } });
    expect(plan.queries.length).toBeLessThanOrEqual(2);
  });

  it("вытаскивает ключевые слова и выбрасывает стоп-слова", () => {
    expect(webResearchKeywords("Аврора будет писать посты про маркировку рекламы")).toEqual(["маркировку", "рекламы"]);
    expect(webResearchTopic("Канал о банкротстве физических лиц")).toBe("банкротстве физических");
  });

  it("отпечаток плана устойчив к порядку категорий", () => {
    const first = planWebResearch({ topic: "маркировка", categories: ["law", "benchmark"] });
    const second = planWebResearch({ topic: "маркировка", categories: ["benchmark", "law"] });
    expect(first.fingerprint).toBe(second.fingerprint);
  });
});

describe("отбор страниц", () => {
  it("выбрасывает поисковики, соцсети и приватные адреса", () => {
    const plan = planWebResearch({ topic: "маркировка рекламы", categories: ["law"] });
    const selected = selectResearchPages([
      { url: "https://www.bing.com/search?q=1" },
      { url: "https://t.me/s/law/1" },
      { url: "http://127.0.0.1/admin" },
      { url: "not a url" },
      { url: "https://publication.pravo.gov.ru/document/1" },
    ], plan, { maxPages: 10 });
    expect(selected.map((page) => page.url)).toEqual(["https://publication.pravo.gov.ru/document/1"]);
    expect(selected[0].tier).toBe("official");
  });

  it("ограничивает число страниц с одного домена", () => {
    const plan = planWebResearch({ topic: "маркировка рекламы", categories: ["law"] });
    const selected = selectResearchPages([
      { url: "https://consultant.ru/a" },
      { url: "https://consultant.ru/b" },
      { url: "https://consultant.ru/c" },
      { url: "https://pravo.ru/d" },
    ], plan, { maxPages: 10, perDomain: 2 });
    expect(selected.filter((page) => page.domain === "consultant.ru")).toHaveLength(2);
    expect(selected.map((page) => page.domain)).toContain("pravo.ru");
  });

  it("распознаёт нечитаемые адреса", () => {
    expect(isReadableResearchUrl("https://example.com/a")).toBe(true);
    expect(isReadableResearchUrl("http://localhost/a")).toBe(false);
    expect(isReadableResearchUrl("javascript:alert(1)")).toBe(false);
    expect(isReadableResearchUrl("https://user:pass@example.com/")).toBe(false);
  });
});

describe("полный цикл исследования", () => {
  it("находит норму права, проходит ворота и пишет журнал", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe("law");
    expect(result.findings[0].legalStatus).toBe("in_force");
    expect(result.findings[0].source.tier).toBe("official");
    expect(result.stats.findings).toBe(1);
    expect(result.log.some((entry) => entry.step === "plan")).toBe(true);
    expect(result.log.some((entry) => entry.step === "read")).toBe(true);
    expect(result.log.some((entry) => entry.step === "gate" && entry.message.includes("Принят факт"))).toBe(true);
  });

  it("выдуманная цитата не попадает в результат, но попадает в журнал", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({
      extract: async () => [{ ...LAW_DRAFT, quote: "закон вступает в силу уже 1 января 2027 года" }],
    }));
    expect(result.findings).toHaveLength(0);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0].code).toBe("quote_not_in_source");
    expect(result.log.some((entry) => entry.step === "gate" && entry.message.includes("Цитата не найдена"))).toBe(true);
  });

  it("выдуманное число в утверждении отклоняется", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({
      extract: async () => [{ ...LAW_DRAFT, claim: "Число проверок сократится на 73 процента", quote: "сокращает число проверок на 40 процентов" }],
    }));
    expect(result.findings).toHaveLength(0);
    expect(result.rejections[0].code).toBe("number_not_in_source");
  });

  it("норма права без статуса не проходит", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({
      extract: async () => [{ ...LAW_DRAFT, legalStatus: null }],
    }));
    expect(result.rejections[0].code).toBe("missing_legal_status");
  });

  it("неизвестный домен без подтверждения не проходит", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({
      search: async () => [{ url: "https://random-blog-2026.ru/law", title: "Закон", snippet: "законопроект" }],
      fetchPage: async () => ({ url: "https://random-blog-2026.ru/law", status: 200, contentType: "text/html", html: LAW_PAGE_HTML }),
    }));
    expect(result.findings).toHaveLength(0);
    expect(result.rejections[0].code).toBe("weak_source");
  });

  it("сбой загрузки страницы не роняет исследование", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({
      fetchPage: async () => { const error = new Error("Сервер не ответил вовремя"); error.code = "timeout"; throw error; },
    }));
    expect(result.findings).toHaveLength(0);
    expect(result.rejections[0].code).toBe("timeout");
    expect(result.log.some((entry) => entry.message.includes("Не удалось прочитать"))).toBe(true);
  });

  it("сбой поиска не роняет исследование", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({
      search: async () => { throw new Error("провайдер недоступен"); },
    }));
    expect(result.findings).toHaveLength(0);
    expect(result.stats.candidates).toBe(0);
    expect(result.log.some((entry) => entry.message.includes("Поиск не ответил"))).toBe(true);
  });

  it("отклоняет нетекстовый тип содержимого", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({
      fetchPage: async () => ({ url: "https://publication.pravo.gov.ru/doc.pdf", status: 200, contentType: "application/pdf", html: "%PDF-1.7" }),
    }));
    expect(result.rejections[0].code).toBe("unsupported_content_type");
  });

  it("извлекает видимый текст и выбрасывает скрипты до передачи модели", async () => {
    const extract = vi.fn(async ({ pageText }) => {
      expect(pageText).not.toContain("tracking()");
      expect(pageText).toContain("вступает в силу");
      return [LAW_DRAFT];
    });
    await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({ extract }));
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("дедуплицирует одинаковые факты из разных запросов", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({
      search: async (query) => [
        { url: "https://publication.pravo.gov.ru/document/1", title: "Закон", snippet: query },
        { url: "https://pravo.gov.ru/news/1", title: "Дубль", snippet: query },
      ],
      fetchPage: async (url) => ({ url, status: 200, contentType: "text/html", html: LAW_PAGE_HTML }),
    }));
    expect(result.findings).toHaveLength(1);
    expect(result.log.some((entry) => entry.message.includes("Дубль факта пропущен"))).toBe(true);
  });

  it("требует все три зависимости", async () => {
    await expect(runWebResearch({ topic: "право" }, {})).rejects.toThrow(/поисковый провайдер/u);
    await expect(runWebResearch({ topic: "право" }, { search: async () => [] })).rejects.toThrow(/загрузчик страниц/u);
    await expect(runWebResearch({ topic: "право" }, { search: async () => [], fetchPage: async () => ({}) }))
      .rejects.toThrow(/извлекатель фактов/u);
  });
});

describe("сводка журнала", () => {
  it("группирует отказы по причинам", () => {
    const summary = summarizeWebResearchRun({
      findings: [{}, {}],
      rejections: [
        { code: "quote_not_in_source" },
        { code: "quote_not_in_source" },
        { code: "weak_source" },
      ],
      stats: { queries: 4, pages: 3, candidates: 12, spentMs: 2_500, deadlineHit: false },
    });
    expect(summary.queries).toBe(4);
    expect(summary.findings).toBe(2);
    expect(summary.rejections).toBe(3);
    expect(summary.rejectionsByCode[0]).toEqual({
      code: "quote_not_in_source", count: 2, reason: "Цитата не найдена в скачанном тексте источника",
    });
  });

  it("переживает пустой запуск", () => {
    const summary = summarizeWebResearchRun(null);
    expect(summary).toMatchObject({ queries: 0, findings: 0, rejections: 0 });
    expect(summary.rejectionsByCode).toEqual([]);
  });
});

describe("формулировка повода", () => {
  it("ставит статус нормы в начало и добавляет источник", () => {
    const angle = webFindingAngle({
      kind: "law",
      claim: "Закон вступает в силу с 1 марта",
      legalStatusLabel: "Закон вступил в силу",
      source: { label: "Официальный интернет-портал правовой информации" },
    });
    expect(angle).toBe("Закон вступил в силу. Закон вступает в силу с 1 марта. Источник: Официальный интернет-портал правовой информации");
  });
});

describe("подтверждение вторым источником", () => {
  const UNREGISTERED_TEXT = sourceTextFromHtml(
    "<p>Федеральный закон от 30.09.2026 № 321-ФЗ вступает в силу с 1 марта 2027 года "
    + "и сокращает число проверок на 40 процентов, сообщает издание.</p>"
    + "<p>Документ опубликован и доступен для ознакомления в полном объёме на портале.</p>",
  );
  const UNREGISTERED_DRAFT = {
    kind: "law",
    claim: "Федеральный закон вступает в силу с 1 марта 2027 года",
    quote: "вступает в силу с 1 марта 2027 года",
    legalStatus: "in_force",
    publishedAt: "2026-09-30T09:00:00.000Z",
  };

  it("один неизвестный домен по-прежнему не проходит", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({
      search: async () => [{ url: "https://one-unknown-blog.ru/law", title: "Закон", snippet: "законопроект" }],
      fetchPage: async () => ({ url: "https://one-unknown-blog.ru/law", status: 200, contentType: "text/html", html: UNREGISTERED_TEXT }),
      extract: async () => [UNREGISTERED_DRAFT],
    }));
    expect(result.findings).toHaveLength(0);
    expect(result.rejections.map((item) => item.code)).toContain("weak_source");
  });

  it("два независимых неизвестных домена с тем же утверждением дают факт", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({
      search: async () => [
        { url: "https://first-unknown-blog.ru/law", title: "Закон", snippet: "законопроект" },
        { url: "https://second-unknown-blog.ru/law", title: "Закон", snippet: "законопроект" },
      ],
      fetchPage: async (url) => ({ url, status: 200, contentType: "text/html", html: UNREGISTERED_TEXT }),
      extract: async () => [UNREGISTERED_DRAFT],
    }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].corroboratedBy).toMatch(/unknown-blog\.ru/u);
    expect(result.log.some((entry) => entry.message.includes("подтверждён вторым источником"))).toBe(true);
  });

  it("два адреса одного домена подтверждением не считаются", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({
      search: async () => [
        { url: "https://same-unknown-blog.ru/a", title: "Закон", snippet: "законопроект" },
        { url: "https://same-unknown-blog.ru/b", title: "Закон", snippet: "законопроект" },
      ],
      fetchPage: async (url) => ({ url, status: 200, contentType: "text/html", html: UNREGISTERED_TEXT }),
      extract: async () => [UNREGISTERED_DRAFT],
    }));
    expect(result.findings).toHaveLength(0);
    expect(result.rejections.every((item) => item.code === "weak_source")).toBe(true);
  });

  it("утверждения на разные темы друг друга не подтверждают", async () => {
    const result = await runWebResearch({ topic: "маркировка рекламы", categories: ["law"] }, deps({
      search: async () => [
        { url: "https://first-unknown-blog.ru/law", title: "Закон", snippet: "законопроект" },
        { url: "https://second-unknown-blog.ru/other", title: "Другое", snippet: "законопроект" },
      ],
      fetchPage: async (url) => ({ url, status: 200, contentType: "text/html", html: UNREGISTERED_TEXT }),
      extract: async ({ page }) => [page.url.includes("second")
        ? { ...UNREGISTERED_DRAFT, claim: "Компания открыла новый офис в Казани", quote: "вступает в силу с 1 марта 2027 года" }
        : UNREGISTERED_DRAFT],
    }));
    // Первое утверждение остаётся без подтверждения, второе вообще не проходит по цитате.
    expect(result.findings).toHaveLength(0);
  });
});
