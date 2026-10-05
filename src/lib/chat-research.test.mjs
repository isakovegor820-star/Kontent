import { describe, expect, it } from "vitest";

import {
  chatResearchEnabled,
  chatResearchReasonText,
  chatResearchTopic,
  detectChatResearchNeed,
} from "./chat-research.mjs";

describe("тема для поиска", () => {
  it("отрезает издательскую обёртку от темы", () => {
    expect(chatResearchTopic("напиши пост - о выходе новой модель от OpenAi"))
      .toBe("выходе новой модель от OpenAi");
    expect(chatResearchTopic("Сделай пост про маркировку рекламы")).toBe("маркировку рекламы");
    expect(chatResearchTopic("Подготовь публикацию на тему налоговой реформы")).toBe("налоговой реформы");
  });

  it("сохраняет исходный текст, если обёртки не было", () => {
    expect(chatResearchTopic("что нового у OpenAI")).toBe("что нового у OpenAI");
  });

  it("снимает несколько обёрток подряд — это была живая жалоба", () => {
    // «Напиши пост на тему; расскажи про 6 astra» давало тему «тему расскажи astra»,
    // запросы вида «тему расскажи astra рынок объём исследование» и ноль найденных
    // страниц: поисковик получал служебные слова вместо темы.
    for (const task of [
      "Напиши пост на тему; расскажи про 6 astra",
      "Напиши пост на тему: расскажи про 6 astra",
      "Напиши пост на тему, расскажи про 6 astra",
    ]) {
      expect(chatResearchTopic(task), task).toBe("6 astra");
    }
    expect(chatResearchTopic("напиши пост на тему маркировка рекламы")).toBe("маркировка рекламы");
  });

  it("не оставляет пустую тему, если запрос состоял из одних обёрток", () => {
    const topic = chatResearchTopic("напиши пост");
    expect(topic.length).toBeGreaterThan(0);
  });

  it("переживает пустой ввод", () => {
    expect(chatResearchTopic("")).toBe("");
    expect(chatResearchTopic(null)).toBe("");
  });
});

describe("нужен ли интернет", () => {
  const need = (task, extra = {}) => detectChatResearchNeed({ task, ...extra });

  it("идёт в интернет на запрос о выходе новой модели — это исходная жалоба", () => {
    const decision = need("напиши пост - о выходе новой модель от OpenAi");
    expect(decision.needed).toBe(true);
    expect(decision.reasons).toContain("content_request");
    expect(decision.reasons).toContain("external_event");
    expect(decision.topic).toBe("выходе новой модель от OpenAi");
  });

  it("идёт в интернет, когда спрашивают о внешнем предмете — это исходная жалоба", () => {
    // «расскажи про 6 astra» раньше давало needed: false, Аврора не шла в сеть и
    // отвечала «в доступных данных нет подтверждённой информации».
    for (const task of [
      "расскажи про 6 astra",
      "Расскажи про 6 Astra",
      "что такое 6 astra",
      "кто такой Сэм Альтман",
      "что известно о новой модели",
    ]) {
      const decision = need(task);
      expect(decision.needed, task).toBe(true);
      expect(decision.reasons, task).toContain("external_subject");
    }
  });

  it("вычищает вопросительную обёртку из поискового запроса", () => {
    expect(need("расскажи про 6 astra").topic).toBe("6 astra");
    expect(need("Расскажи мне про 6 Astra").topic).toBe("6 Astra");
    expect(chatResearchTopic("расскажи онлайн про X")).toBe("расскажи онлайн про X");
  });

  it("не идёт в сеть на «расскажи подробнее» — это просьба продолжить, а не вопрос о мире", () => {
    expect(need("расскажи подробнее").needed).toBe(false);
  });

  it("не идёт в сеть, когда «расскажи про» касается содержимого канала", () => {
    for (const task of ["расскажи про наши рубрики", "расскажи про мои посты", "расскажи про мой контент-план"]) {
      expect(need(task).needed, task).toBe(false);
    }
  });

  it("идёт в интернет для любой темы поста, а не только про OpenAI", () => {
    for (const task of [
      "напиши пост про рынок кофе в России",
      "сделай пост о налоге на самозанятых",
      "подготовь обзор новых видеокарт",
      "нужен лонгрид о кибербезопасности малого бизнеса",
    ]) {
      expect(need(task).needed, task).toBe(true);
    }
  });

  it("идёт в интернет по норме права и берёт категорию «право»", () => {
    const decision = need("какие законы вступили в силу с 1 марта 2026 года");
    expect(decision.needed).toBe(true);
    expect(decision.categories).toContain("law");
    expect(decision.reasons).toContain("legal");
  });

  it("идёт в интернет по прямой просьбе проверить", () => {
    const decision = need("проверь, что там с новыми тарифами связи");
    expect(decision.needed).toBe(true);
    expect(decision.reasons).toContain("explicit_request");
  });

  it("идёт в интернет по бенчмаркам", () => {
    const decision = need("сравни новые модели по бенчмаркам");
    expect(decision.needed).toBe(true);
    expect(decision.categories).toContain("benchmark");
  });

  it("не идёт в сеть на чистую редактуру", () => {
    expect(need("сократи этот текст вдвое").needed).toBe(false);
    expect(need("перепиши последний абзац другими словами").needed).toBe(false);
    expect(need("сделай короче и мягче").needed).toBe(false);
  });

  it("не идёт в сеть на вопросы о самой платформе", () => {
    expect(need("что ты умеешь").needed).toBe(false);
    expect(need("как настроить автопилот").needed).toBe(false);
    expect(need("какие у меня рубрики в паспорте канала").needed).toBe(false);
  });

  it("не идёт в сеть на внутренние темы канала", () => {
    expect(need("напиши пост про наши рубрики").needed).toBe(false);
    expect(need("перепиши наши посты в другом тоне").needed).toBe(false);
  });

  it("наследует тему из предыдущей реплики на короткий ответ", () => {
    const decision = detectChatResearchNeed({
      task: "да, давай",
      history: [{ role: "user", text: "напиши пост о выходе новой модели OpenAI" }],
    });
    expect(decision.needed).toBe(true);
    expect(decision.topic).toContain("OpenAI");
  });

  it("на пустом вводе ничего не делает", () => {
    expect(need("").needed).toBe(false);
    expect(detectChatResearchNeed({}).needed).toBe(false);
  });

  it("возвращает человекочитаемую причину для журнала", () => {
    expect(chatResearchReasonText(["content_request", "external_event"]))
      .toBe("Запрос на пост по внешней теме, Событие во внешнем мире");
    expect(chatResearchReasonText([])).toBe("Тема требует внешних данных");
  });
});

describe("выключатель выхода в интернет", () => {
  it("по умолчанию включён в боевом окружении", () => {
    expect(chatResearchEnabled({})).toBe(true);
    expect(chatResearchEnabled({ NODE_ENV: "production" })).toBe(true);
  });

  it("молчит под тестовым раннером, иначе прогон открывал бы реальные соединения", () => {
    // safe-http ходит через node:https и не видит подменённый global.fetch.
    expect(chatResearchEnabled({ VITEST: "true" })).toBe(false);
  });

  it("явное решение владельца сильнее умолчания", () => {
    expect(chatResearchEnabled({ VITEST: "true", AURORA_CHAT_RESEARCH: "on" })).toBe(true);
    expect(chatResearchEnabled({ AURORA_CHAT_RESEARCH: "off" })).toBe(false);
    expect(chatResearchEnabled({ AURORA_CHAT_RESEARCH: "false" })).toBe(false);
    expect(chatResearchEnabled({ AURORA_CHAT_RESEARCH: "1" })).toBe(true);
    expect(chatResearchEnabled({ AURORA_CHAT_RESEARCH: "enabled" })).toBe(true);
  });
});
