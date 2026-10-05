import { describe, expect, it, vi } from "vitest";

import { entitySearchQueries, resolveTopicEntity } from "./web-entity-resolution.mjs";

/** Ответ Wikipedia в той форме, в которой его отдаёт action=query&list=search. */
const wiki = (entries) => ({
  ok: true,
  status: 200,
  json: async () => ({
    query: {
      search: entries.map((entry) => (typeof entry === "string"
        ? { title: entry, snippet: `Статья про ${entry}` }
        : entry)),
    },
  }),
});

describe("распознавание сущности", () => {
  it("подставляет каноническое имя вместо строки пользователя", async () => {
    // Реальная причина низкого качества выдачи: на «6 astra» бесплатные движки отдают
    // «Sechs – Wikipedia» и «LOTTO 6aus49», а на «GPT-6 Astra» — страницу openai.com.
    const fetchImpl = vi.fn(async (url) => {
      // Сниппет первой статьи упоминает и «gpt», и «astra» — как в настоящей выдаче
      // Wikipedia на запрос «6 astra», где первой идёт статья про GPT-6.
      if (String(url).includes("ru.wikipedia.org")) {
        return wiki([
          { title: "GPT-6", snippet: "GPT-6 Astra — шестое поколение модели OpenAI" },
          { title: "Astra Linux", snippet: "Российская операционная система" },
          { title: "Opel Astra", snippet: "Автомобиль немецкой марки Opel" },
        ]);
      }
      return wiki(["GPT-6", "GPT-6.1"]);
    });
    const entity = await resolveTopicEntity("6 astra", { fetchImpl });
    expect(entity.canonical).toBe("GPT-6");
    expect(entity.titles[0]).toBe("GPT-6");
    expect(entity.source).toBe("wikipedia");
  });

  it("не подставляет сущность, если совпадений по теме нет", async () => {
    const fetchImpl = vi.fn(async () => wiki(["Совершенно другая статья", "Ещё одна"]));
    const entity = await resolveTopicEntity("6 astra", { fetchImpl });
    expect(entity.canonical).toBeNull();
    expect(entity.titles).toEqual([]);
  });

  it("переживает недоступность Wikipedia", async () => {
    const failing = vi.fn(async () => { throw new Error("network down"); });
    await expect(resolveTopicEntity("6 astra", { fetchImpl: failing })).resolves.toMatchObject({ canonical: null });
    const notOk = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(resolveTopicEntity("6 astra", { fetchImpl: notOk })).resolves.toMatchObject({ canonical: null });
  });

  it("на коротком запросе не ходит в сеть", async () => {
    const fetchImpl = vi.fn();
    await resolveTopicEntity("аб", { fetchImpl });
    await resolveTopicEntity("", { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("запросы из распознанной сущности", () => {
  it("склеивает каноническое имя с различающей основой темы", () => {
    const queries = entitySearchQueries({ canonical: "GPT-6", titles: ["GPT-6", "GPT-6.1"] }, "6 astra");
    expect(queries[0]).toBe("GPT-6 astra");
    expect(queries).toContain("GPT-6");
    expect(queries).toContain("GPT-6.1");
  });

  it("не дублирует основу, которая уже есть в имени сущности", () => {
    const queries = entitySearchQueries({ canonical: "Astra Linux", titles: ["Astra Linux"] }, "astra linux");
    expect(queries.filter((query) => query === "Astra Linux astra")).toEqual([]);
  });

  it("без сущности не придумывает запросы", () => {
    expect(entitySearchQueries(null, "6 astra")).toEqual([]);
    expect(entitySearchQueries({ canonical: null, titles: [] }, "6 astra")).toEqual([]);
  });
});
