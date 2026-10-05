import { describe, expect, it } from "vitest";

import {
  buildWebFinding,
  classifyLegalStatus,
  evaluateWebFinding,
  extractClaimNumbers,
  looksLikeBlockedPage,
  normalizeForMatch,
  sourceTextFromHtml,
  verifyQuoteInSource,
  webFindingCitation,
  webFindingFingerprint,
  WebFindingRejected,
} from "./web-research-contract.mjs";
import { normalizeWebDomain, resolveWebSource, webSourceDomainsForCategory } from "./web-research-sources.mjs";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");

// Реальный по форме фрагмент страницы официального опубликования.
const SOURCE_PAGE = sourceTextFromHtml(`
  <html><head><title>Федеральный закон</title>
  <script>window.__data = {secret: true};</script>
  <style>.lead { color: red; }</style></head>
  <body>
    <h1>О внесении изменений в отдельные законодательные акты</h1>
    <p>Федеральный закон от 30.09.2026 № 321-ФЗ «О внесении изменений» вступает в силу
    с 1 марта 2027 года.</p>
    <p>Документ опубликован на Официальном интернет-портале правовой информации.</p>
    <p>Согласно пояснительной записке, число проверок сократится на 40 процентов,
    а срок ответа на обращение составит 30 дней.</p>
  </body></html>
`);

const LAW_INPUT = {
  kind: "law",
  claim: "Федеральный закон вступает в силу с 1 марта 2027 года",
  quote: "вступает в силу с 1 марта 2027 года",
  sourceUrl: "https://publication.pravo.gov.ru/document/0001202609300001",
  sourceText: SOURCE_PAGE,
  publishedAt: "2026-09-30T09:00:00.000Z",
  legalStatus: "in_force",
};

describe("реестр источников", () => {
  it("приводит URL и хост к registrable-домену без www", () => {
    expect(normalizeWebDomain("https://www.Consultant.ru/document/cons_doc_LAW_1/")).toBe("consultant.ru");
    expect(normalizeWebDomain("consultant.ru")).toBe("consultant.ru");
    expect(normalizeWebDomain("не адрес")).toBeNull();
    expect(normalizeWebDomain("")).toBeNull();
  });

  it("находит запись реестра по поддомену", () => {
    const entry = resolveWebSource("https://publication.pravo.gov.ru/document/1");
    expect(entry.tier).toBe("official");
    expect(entry.domain).toBe("pravo.gov.ru");
    expect(entry.registered).toBe(true);
  });

  it("неизвестный домен получает открытый уровень доверия", () => {
    const entry = resolveWebSource("https://example-blog-2026.ru/post/1");
    expect(entry.tier).toBe("open");
    expect(entry.registered).toBe(false);
  });

  it("помечает поисковики и соцсети как не-источники", () => {
    expect(resolveWebSource("https://www.bing.com/search?q=1").nonSource).toBe(true);
    expect(resolveWebSource("https://t.me/s/somechannel").nonSource).toBe(true);
    expect(resolveWebSource("https://consultant.ru/document/1").nonSource).toBe(false);
  });

  it("выдаёт домены категории по убыванию доверия", () => {
    const domains = webSourceDomainsForCategory("law", { tiers: ["official"] });
    expect(domains).toContain("pravo.gov.ru");
    expect(domains).toContain("sozd.duma.gov.ru");
    expect(domains.every((domain) => resolveWebSource(domain).tier === "official")).toBe(true);
  });
});

describe("извлечение текста страницы", () => {
  it("выбрасывает скрипты, стили и теги", () => {
    expect(SOURCE_PAGE).not.toContain("window.__data");
    expect(SOURCE_PAGE).not.toContain("color: red");
    expect(SOURCE_PAGE).not.toContain("<p>");
    expect(SOURCE_PAGE).toContain("вступает в силу");
  });

  it("раскрывает html-сущности", () => {
    expect(sourceTextFromHtml("<p>Право &laquo;Аврора&raquo; &amp; Co&nbsp;2026</p>")).toBe("Право «Аврора» & Co 2026");
  });
});

describe("проверка цитаты", () => {
  it("находит цитату, отличающуюся только типографикой", () => {
    const check = verifyQuoteInSource(
      "Закон «О связи» вступает в силу — с 1 марта 2027 года",
      "закон \"о связи\" вступает в силу - с 1 марта 2027 года",
    );
    expect(check.found).toBe(true);
  });

  it("игнорирует букву ё и лишние пробелы", () => {
    expect(verifyQuoteInSource("внесён в государственную думу законопроект", "внесен в  государственную   думу законопроект").found).toBe(true);
  });

  it("отклоняет цитату, которой нет в источнике", () => {
    const check = verifyQuoteInSource("закон вступит в силу уже 1 января 2027 года", SOURCE_PAGE);
    expect(check.found).toBe(false);
    expect(check.reason).toBe("quote_not_in_source");
  });

  it("отклоняет слишком короткую цитату", () => {
    expect(verifyQuoteInSource("закон", SOURCE_PAGE)).toEqual({ found: false, reason: "missing_quote" });
  });

  it("принимает склейку двух предложений через многоточие, если обе части есть", () => {
    const check = verifyQuoteInSource(
      "Федеральный закон от 30.09.2026 № 321-ФЗ … вступает в силу с 1 марта 2027 года",
      SOURCE_PAGE,
    );
    expect(check.found).toBe(true);
  });
});

describe("классификация юридического статуса", () => {
  it("распознаёт вступивший в силу закон", () => {
    expect(classifyLegalStatus("Федеральный закон вступает в силу с 1 марта").status).toBe("in_force");
  });

  it("распознаёт подписание", () => {
    expect(classifyLegalStatus("Президент подписал федеральный закон о связи").status).toBe("signed");
  });

  it("распознаёт законопроект во втором чтении, а не как действующий закон", () => {
    const result = classifyLegalStatus("Госдума приняла законопроект во втором чтении");
    expect(result.status).toBe("bill_second_reading");
  });

  it("распознаёт внесённый законопроект по номеру", () => {
    expect(classifyLegalStatus("В Госдуму внесён законопроект № 123456-8").status).toBe("bill_submitted");
  });

  it("распознаёт публичное обсуждение", () => {
    expect(classifyLegalStatus("Обсуждается инициатива о маркировке рекламы").status).toBe("public_discussion");
  });

  it("не считает нормой права обычный текст", () => {
    expect(classifyLegalStatus("Компания выпустила новую версию продукта").status).toBe("not_normative");
  });

  it("на пустом тексте возвращает unknown", () => {
    expect(classifyLegalStatus("").status).toBe("unknown");
  });
});

describe("числа и нормализация", () => {
  it("извлекает многозначные числа и игнорирует одиночные цифры", () => {
    expect(extractClaimNumbers("сократится на 40 процентов, срок 30 дней, 1 марта")).toEqual(["40", "30"]);
  });

  it("нормализует ё, тире, кавычки и пробелы", () => {
    expect(normalizeForMatch("Закон  «О связи» — вступил в силу")).toBe('закон "о связи" - вступил в силу');
  });
});

describe("ворота факта: прохождение", () => {
  it("пропускает корректную норму права с официального источника", () => {
    const result = evaluateWebFinding(LAW_INPUT, { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.finding.source.tier).toBe("official");
    expect(result.finding.legalStatus).toBe("in_force");
    expect(result.finding.legalStatusLabel).toBe("Закон вступил в силу");
    expect(result.finding.trusted).toBe(true);
    expect(result.finding.fingerprint).toMatch(/^wf-/u);
  });

  it("buildWebFinding возвращает факт, а не обёртку", () => {
    const finding = buildWebFinding(LAW_INPUT, { now: NOW });
    expect(finding.kind).toBe("law");
    expect(finding.source.url).toContain("publication.pravo.gov.ru");
  });

  it("пропускает бенчмарк с зарубежного исследовательского источника", () => {
    const text = sourceTextFromHtml(
      "<p>In our benchmark the model reaches 87 percent accuracy on the reasoning suite, "
      + "compared with 74 percent for the previous generation, according to the published evaluation. "
      + "We ran the suite three times on identical hardware and report the median result. "
      + "The full evaluation protocol, including prompts and scoring rules, is described in section four.</p>",
    );
    const result = evaluateWebFinding({
      kind: "benchmark",
      claim: "Модель показывает 87 процентов точности против 74 у прошлого поколения",
      quote: "the model reaches 87 percent accuracy on the reasoning suite",
      sourceUrl: "https://arxiv.org/abs/2610.00001",
      sourceText: text,
      publishedAt: "2026-08-01T00:00:00.000Z",
    }, { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.finding.source.tier).toBe("research");
  });
});

describe("ворота факта: отказы", () => {
  const rejected = (input, options = {}) => {
    const result = evaluateWebFinding(input, { now: NOW, ...options });
    expect(result.ok).toBe(false);
    return result.code;
  };

  it("нет ссылки — нет факта", () => {
    expect(rejected({ ...LAW_INPUT, sourceUrl: "" })).toBe("missing_url");
    expect(rejected({ ...LAW_INPUT, sourceUrl: "ftp://pravo.gov.ru/x" })).toBe("bad_url");
  });

  it("поисковик или соцсеть не может быть источником факта", () => {
    expect(rejected({ ...LAW_INPUT, sourceUrl: "https://www.bing.com/search?q=закон" })).toBe("non_source_domain");
    expect(rejected({ ...LAW_INPUT, sourceUrl: "https://t.me/s/lawnews/123" })).toBe("non_source_domain");
  });

  it("выдуманная цитата не проходит", () => {
    expect(rejected({ ...LAW_INPUT, quote: "закон вступит в силу 1 января 2027 года немедленно" })).toBe("quote_not_in_source");
  });

  it("пустая цитата не проходит", () => {
    expect(rejected({ ...LAW_INPUT, quote: "" })).toBe("missing_quote");
  });

  it("слишком короткая страница не годится для проверки", () => {
    expect(rejected({ ...LAW_INPUT, sourceText: "коротко" })).toBe("source_too_short");
  });

  it("без даты публикации факт не проходит", () => {
    expect(rejected({ ...LAW_INPUT, publishedAt: "" })).toBe("missing_published_at");
    expect(rejected({ ...LAW_INPUT, publishedAt: "не дата" })).toBe("bad_published_at");
  });

  it("дата в будущем отклоняется", () => {
    expect(rejected({ ...LAW_INPUT, publishedAt: "2027-01-01T00:00:00.000Z" })).toBe("future_dated_source");
  });

  it("старый источник отклоняется с учётом типа факта", () => {
    const yearOld = "2025-10-01T00:00:00.000Z";
    // Событие живёт 60 дней, поэтому годичной давности новость не пройдёт.
    expect(rejected({ ...LAW_INPUT, kind: "event", legalStatus: "", publishedAt: yearOld })).toBe("stale_source");
    // А норма права живёт три года — тот же материал проходит.
    expect(evaluateWebFinding({ ...LAW_INPUT, publishedAt: yearOld }, { now: NOW }).ok).toBe(true);
  });

  it("норма права без юридического статуса не проходит", () => {
    expect(rejected({ ...LAW_INPUT, legalStatus: "" })).toBe("missing_legal_status");
    expect(rejected({ ...LAW_INPUT, legalStatus: "unknown" })).toBe("unknown_legal_status");
    expect(rejected({ ...LAW_INPUT, legalStatus: "выдуманный" })).toBe("unknown_legal_status");
  });

  it("выдуманное число не проходит, даже если цитата настоящая", () => {
    expect(rejected({
      ...LAW_INPUT,
      claim: "Число проверок сократится на 73 процента",
      quote: "число проверок сократится на 40 процентов",
    })).toBe("number_not_in_source");
  });

  it("неизвестный домен в одиночку не годится", () => {
    const text = sourceTextFromHtml(`<p>${"Аналитики отмечают рост рынка на 12 процентов. ".repeat(6)}</p>`);
    expect(rejected({
      kind: "market",
      claim: "Рынок вырос на 12 процентов",
      quote: "Аналитики отмечают рост рынка на 12 процентов",
      sourceUrl: "https://unknown-analytics-blog.ru/market",
      sourceText: text,
      publishedAt: "2026-09-01T00:00:00.000Z",
    })).toBe("weak_source");
  });

  it("неизвестный домен проходит при независимом подтверждении", () => {
    const text = sourceTextFromHtml(`<p>${"Аналитики отмечают рост рынка на 12 процентов. ".repeat(6)}</p>`);
    const result = evaluateWebFinding({
      kind: "market",
      claim: "Рынок вырос на 12 процентов",
      quote: "Аналитики отмечают рост рынка на 12 процентов",
      sourceUrl: "https://unknown-analytics-blog.ru/market",
      sourceText: text,
      publishedAt: "2026-09-01T00:00:00.000Z",
      corroborating: [{ url: "https://www.rbc.ru/business/2026/09/01/market" }, { url: "https://unknown-analytics-blog.ru/market" }],
    }, { now: NOW });
    expect(result.ok).toBe(true);
    expect(result.finding.corroborationCount).toBe(1);
    expect(result.finding.corroboratingDomains).toEqual(["rbc.ru"]);
  });

  it("buildWebFinding бросает типизированную ошибку с кодом", () => {
    const invented = "закон вступит в силу 1 января 2027 года и отменит все проверки";
    expect(() => buildWebFinding({ ...LAW_INPUT, quote: invented }, { now: NOW }))
      .toThrow(WebFindingRejected);
    try {
      buildWebFinding({ ...LAW_INPUT, quote: invented }, { now: NOW });
    } catch (error) {
      expect(error.code).toBe("quote_not_in_source");
      expect(error.message).toBe("Цитата не найдена в скачанном тексте источника");
    }
  });

  it("слишком короткая цитата отличается от отсутствующей в источнике", () => {
    expect(rejected({ ...LAW_INPUT, quote: "закон" })).toBe("missing_quote");
  });
});

describe("подпись источника", () => {
  it("ставит статус нормы перед названием источника", () => {
    const finding = buildWebFinding(LAW_INPUT, { now: NOW });
    const citation = webFindingCitation(finding);
    expect(citation).toContain("Закон вступил в силу. Официальный интернет-портал правовой информации (2026-09-30)");
    expect(citation).toContain("https://publication.pravo.gov.ru/document/0001202609300001");
  });

  it("для не-нормы статус не подставляется", () => {
    const finding = buildWebFinding({
      kind: "statement",
      claim: "Компания представила платформу",
      quote: "Компания представила платформу",
      sourceUrl: "https://habr.com/ru/news/1/",
      sourceText: sourceTextFromHtml(`<p>${"Компания представила платформу для работы с данными. ".repeat(6)}</p>`),
      publishedAt: "2026-09-20T00:00:00.000Z",
    }, { now: NOW });
    expect(webFindingCitation(finding).startsWith("Хабр")).toBe(true);
  });
});

describe("отпечаток факта", () => {
  it("устойчив к типографике и порядку вызова", () => {
    const first = buildWebFinding(LAW_INPUT, { now: NOW });
    const second = buildWebFinding({ ...LAW_INPUT, claim: LAW_INPUT.claim.replace(/ /gu, "  ") }, { now: NOW + 1000 });
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("различает разные источники", () => {
    const first = buildWebFinding(LAW_INPUT, { now: NOW });
    const other = buildWebFinding({ ...LAW_INPUT, sourceUrl: "https://pravo.gov.ru/news/1" }, { now: NOW });
    expect(first.fingerprint).not.toBe(other.fingerprint);
  });

  it("webFindingFingerprint переживает частичный объект", () => {
    expect(webFindingFingerprint(null)).toMatch(/^wf-/u);
  });
});

describe("страница-заглушка вместо источника", () => {
  it("распознаёт отказ доступа и проверку бота", () => {
    // developers.openai.com ответил «You don't have permission to access…», и этот
    // текст попадал в факты как утверждение со ссылкой на источник.
    expect(looksLikeBlockedPage('You don\'t have permission to access "http://example.com/x" on this server.')).toBe(true);
    expect(looksLikeBlockedPage("Checking your browser before accessing example.com. Just a moment...")).toBe(true);
    expect(looksLikeBlockedPage("Доступ запрещён. Подтвердите, что вы не робот.")).toBe(true);
  });

  it("не трогает нормальную статью", () => {
    expect(looksLikeBlockedPage("Правила маркировки рекламы в 2026 году: кто обязан маркировать креативы и как отчитываться.")).toBe(false);
    expect(looksLikeBlockedPage("")).toBe(false);
    expect(looksLikeBlockedPage(null)).toBe(false);
  });
});
