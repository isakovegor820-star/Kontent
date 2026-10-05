import { describe, expect, it, vi } from "vitest";

import {
  createWebSearchApiProvider,
  normalizeProviderResult,
  parseProviderPayload,
  resolveWebSearchProviders,
  webSearchApiConfigured,
} from "./web-search-provider.mjs";

/** Ответ в форме Bocha/Tavily: результаты в `data`/`results`. */
const jsonResponse = (payload, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => payload,
});

const ENDPOINT = "https://api.example.com/v1/search";

describe("разбор ответа поискового сервиса", () => {
  it("понимает формы результатов разных сервисов", () => {
    for (const payload of [
      { results: [{ url: "https://a.ru/1", title: "A", snippet: "S" }] },
      { data: [{ link: "https://a.ru/1", name: "A", description: "S" }] },
      { items: [{ url: "https://a.ru/1", headline: "A", content: "S" }] },
      { webPages: { value: [{ url: "https://a.ru/1", title: "A", summary: "S" }] } },
      { search_result: [{ url: "https://a.ru/1", title: "A", text: "S" }] },
      [{ url: "https://a.ru/1", title: "A", snippet: "S" }],
    ]) {
      const results = parseProviderPayload(payload);
      expect(results, JSON.stringify(payload).slice(0, 40)).toHaveLength(1);
      expect(results[0].url).toBe("https://a.ru/1");
      expect(results[0].title).toBe("A");
      expect(results[0].snippet).toBe("S");
    }
  });

  it("разбирает дату публикации и не выдумывает её из мусора", () => {
    expect(normalizeProviderResult({ url: "https://a.ru/1", publishedAt: "2026-09-30T09:00:00Z" }).publishedAt)
      .toBe("2026-09-30T09:00:00.000Z");
    expect(normalizeProviderResult({ url: "https://a.ru/1", date: "2026-09-30" }).publishedAt)
      .toBe("2026-09-30T00:00:00.000Z");
    expect(normalizeProviderResult({ url: "https://a.ru/1", page_age: "3 days ago" }).publishedAt).toBeNull();
  });

  it("отбрасывает элементы без адреса и дубли", () => {
    const results = parseProviderPayload({
      results: [
        { title: "без ссылки" },
        { url: "https://a.ru/1", title: "первый" },
        { url: "https://a.ru/1", title: "дубль" },
        { url: "https://b.ru/2", title: "второй" },
      ],
    });
    expect(results.map((item) => item.url)).toEqual(["https://a.ru/1", "https://b.ru/2"]);
  });

  it("на пустом и чужом ответе отдаёт пустой список, а не исключение", () => {
    for (const payload of [null, undefined, "", 42, {}, { error: "quota" }]) {
      expect(parseProviderPayload(payload)).toEqual([]);
    }
  });
});

describe("адаптер поискового API", () => {
  it("не создаётся без адреса эндпоинта", () => {
    expect(createWebSearchApiProvider({})).toBeNull();
    expect(createWebSearchApiProvider({ endpoint: "  " })).toBeNull();
  });

  it("в стиле query уходит GET с параметрами и заголовком авторизации", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [{ url: "https://a.ru/1", title: "A" }] }));
    const provider = createWebSearchApiProvider({
      endpoint: ENDPOINT,
      apiKey: "secret",
      style: "query",
      maxResults: 5,
      fetchImpl,
    });
    const results = await provider.search("6 astra");
    expect(results).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("q=6+astra");
    expect(String(url)).toContain("count=5");
    expect(init.method).toBe("GET");
    expect(init.headers.authorization).toBe("Bearer secret");
  });

  it("в стиле json уходит POST с телом и ключом в теле запроса-носителя", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ link: "https://a.ru/1", name: "A" }] }));
    const provider = createWebSearchApiProvider({
      endpoint: ENDPOINT,
      apiKey: "secret",
      style: "json",
      fetchImpl,
    });
    const results = await provider.search("6 astra");
    expect(results[0].url).toBe("https://a.ru/1");
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ query: "6 astra", count: 10 });
  });

  it("позволяет переопределить заголовок авторизации", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    const provider = createWebSearchApiProvider({
      endpoint: ENDPOINT,
      apiKey: "secret",
      apiKeyHeader: "x-api-key",
      fetchImpl,
    });
    await provider.search("q");
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers["x-api-key"]).toBe("Bearer secret");
  });

  it("на ошибке сервиса бросает код, а не молчит", async () => {
    const provider = createWebSearchApiProvider({
      endpoint: ENDPOINT,
      fetchImpl: async () => jsonResponse({}, false, 429),
    });
    await expect(provider.search("q")).rejects.toMatchObject({ code: "search_api_http_429" });
  });
});

describe("конфигурация из окружения", () => {
  it("собирает адаптер из переменных AURORA_SEARCH_API_*", () => {
    const resolved = resolveWebSearchProviders({
      AURORA_SEARCH_API_URL: ENDPOINT,
      AURORA_SEARCH_API_KEY: "k",
      AURORA_SEARCH_API_STYLE: "json",
      RADAR_SEARXNG_URL: "http://127.0.0.1:8080",
    });
    expect(resolved.api).not.toBeNull();
    expect(resolved.searxngUrl).toBe("http://127.0.0.1:8080");
    expect(webSearchApiConfigured({ AURORA_SEARCH_API_URL: ENDPOINT })).toBe(true);
  });

  it("без ключа остаётся работоспособным на бесплатных адаптерах", () => {
    const resolved = resolveWebSearchProviders({});
    expect(resolved.api).toBeNull();
    expect(webSearchApiConfigured({})).toBe(false);
  });
});
