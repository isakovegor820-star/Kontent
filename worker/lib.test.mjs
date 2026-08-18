// Тесты чистого ядра воркера. Это самая хрупкая логика проекта (регейкс-парсинг t.me/s/
// и «страж фактов» уже ломались), поэтому покрыта в первую очередь.
import { describe, it, expect } from "vitest";
import {
  parseCount,
  sumReactions,
  decodeEntities,
  splitChunks,
  plural,
  periodSlots,
  weekSlots,
  toTelegramHtml,
  keyboard,
  findInvented,
  stripCites,
  citedShare,
  mapConcurrent,
  autopilotBuildComplete,
  autopilotDraftsDeliverable,
  autopilotJobAttemptsExhausted,
  autopilotJobTerminalFailure,
  boundedAutopilotRewriteAttempts,
  formatPost,
  parseTelegramChannelDescription,
  summarizeTelegramPostingActivity,
} from "./lib.mjs";

describe("parseCount", () => {
  it("разбирает тысячи и миллионы", () => {
    expect(parseCount("1.2K")).toBe(1200);
    expect(parseCount("30.7K")).toBe(30700);
    expect(parseCount("1.5M")).toBe(1500000);
    expect(parseCount("2k")).toBe(2000);
  });
  it("разбирает обычные числа и убирает пробелы", () => {
    expect(parseCount("50")).toBe(50);
    expect(parseCount("1 200")).toBe(1200);
  });
  it("возвращает null на мусор", () => {
    expect(parseCount("abc")).toBeNull();
    expect(parseCount("")).toBeNull();
  });
});

describe("sumReactions", () => {
  it("суммирует реакции из вложенного tg-emoji (регресс бага «всегда 0»)", () => {
    const block =
      '<span class="tgme_reaction"><tg-emoji emoji-id="100">👍</tg-emoji>30.7K</span>';
    expect(sumReactions(block)).toBe(30700);
  });
  it("складывает несколько реакций", () => {
    const block =
      '<span class="tgme_reaction"><tg-emoji>👍</tg-emoji>1K</span>' +
      '<span class="tgme_reaction"><tg-emoji>🔥</tg-emoji>500</span>';
    expect(sumReactions(block)).toBe(1500);
  });
  it("null, когда реакции выключены (нет span)", () => {
    expect(sumReactions("<div>поста без реакций</div>")).toBeNull();
  });
});

describe("parseTelegramChannelDescription", () => {
  it("извлекает читаемое описание со ссылками, переносами и HTML-сущностями", () => {
    const html = `
      <div class="tgme_channel_info_description">
        Практика для бизнеса &amp; юристов.<br>
        Автор: <a href="https://t.me/example">Иван Петров</a>
      </div>`;

    expect(parseTelegramChannelDescription(html)).toBe(
      "Практика для бизнеса & юристов.\nАвтор: Иван Петров",
    );
  });

  it("учитывает дополнительные классы и возвращает null без описания", () => {
    expect(
      parseTelegramChannelDescription(
        '<div class="compact tgme_channel_info_description visible">Описание</div>',
      ),
    ).toBe("Описание");
    expect(parseTelegramChannelDescription("<main>Нет шапки</main>")).toBeNull();
  });
});

describe("summarizeTelegramPostingActivity", () => {
  it("считает дату последнего поста и недавний недельный темп", () => {
    expect(
      summarizeTelegramPostingActivity([
        { postedAt: "2026-08-01T10:00:00.000Z" },
        { postedAt: "2026-07-29T10:00:00.000Z" },
        { postedAt: "2026-07-25T10:00:00.000Z" },
        { postedAt: "2026-07-22T10:00:00.000Z" },
        { postedAt: "2026-07-18T10:00:00.000Z" },
      ]),
    ).toEqual({
      lastPostAt: "2026-08-01T10:00:00.000Z",
      postsPerWeek: 2,
    });
  });

  it("возвращает только дату при одном посте и null без валидных дат", () => {
    expect(
      summarizeTelegramPostingActivity([{ postedAt: "2026-08-01T10:00:00.000Z" }]),
    ).toEqual({ lastPostAt: "2026-08-01T10:00:00.000Z", postsPerWeek: null });
    expect(summarizeTelegramPostingActivity([{ postedAt: null }])).toEqual({
      lastPostAt: null,
      postsPerWeek: null,
    });
  });
});

describe("splitChunks", () => {
  it("пусто на пустом вводе", () => {
    expect(splitChunks("")).toEqual([]);
    expect(splitChunks("   \n  ")).toEqual([]);
  });
  it("один абзац — один кусок", () => {
    expect(splitChunks("Привет мир")).toEqual(["Привет мир"]);
  });
  it("абзацы длиннее порога разделяются по пустой строке", () => {
    const a = "Это первый достаточно длинный абзац, который точно превышает минимальный порог длины куска.";
    const b = "Это второй достаточно длинный абзац, который тоже превышает минимальный порог длины куска.";
    expect(splitChunks(`${a}\n\n${b}`)).toEqual([a, b]);
  });
  it("короткий хвост приклеивается к предыдущему куску", () => {
    const long = "А".repeat(100); // > CHUNK_MIN, самостоятельный кусок
    const out = splitChunks(`${long}\n\nКоротко`);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(`${long}\n\nКоротко`);
  });
  it("длинный абзац режется по границам предложений, не превышая предел", () => {
    const sentence = "А".repeat(180) + "."; // 181 знак
    const para = Array(6).fill(sentence).join(" "); // ~1091 знак > 900
    const out = splitChunks(para);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(900);
  });
});

describe("findInvented (страж фактов)", () => {
  it("чистый пост без конкретики — пустой список", () => {
    expect(findInvented("Общие слова без конкретики.", [{ text: "факты" }])).toEqual([]);
  });
  it("ловит выдуманный номер статьи", () => {
    const bad = findInvented("Согласно статье 15 ГК РФ.", [{ text: "факт без чисел" }]);
    expect(bad.some((x) => x.startsWith("статья"))).toBe(true);
  });
  it("пропускает статью, число которой есть в фактах", () => {
    expect(findInvented("статья 15", [{ text: "пункт 15 договора" }])).toEqual([]);
  });
  it("ловит выдуманную дату", () => {
    const bad = findInvented("Решение от 10 июля 2026 года.", [{ text: "иное" }]);
    expect(bad.some((x) => x.startsWith("дата"))).toBe(true);
  });
  it("ловит подмену срока словами", () => {
    const bad = findInvented("Придётся ждать три месяца.", [{ text: "факт" }]);
    expect(bad.some((x) => x.startsWith("срок"))).toBe(true);
  });
  it("пропускает срок, который есть в фактах", () => {
    expect(findInvented("ждать три месяца", [{ text: "срок три месяца" }])).toEqual([]);
  });
  it("понимает падежи одного и того же срока", () => {
    expect(findInvented("в течение шести месяцев", [{ text: "срок шесть месяцев" }])).toEqual([]);
  });
  it("не объявляет подтверждённую сумму с пробелами выдумкой", () => {
    expect(findInvented("Долг составил 2 300 000 рублей.", [{ text: "долг 2 300 000 рублей" }])).toEqual([]);
  });
});

describe("citedShare / stripCites", () => {
  it("доля предложений со ссылкой", () => {
    const text =
      "Это длинное предложение со ссылкой [1]. А это короткое. Это ещё одно длинное предложение без ссылки.";
    expect(citedShare(text)).toBe(0.5);
  });
  it("0 на пустом тексте", () => {
    expect(citedShare("")).toBe(0);
  });
  it("stripCites убирает маркеры ссылок", () => {
    expect(stripCites("Текст [1] со ссылкой [2].")).toBe("Текст со ссылкой.");
    expect(stripCites("без ссылок")).toBe("без ссылок");
  });
});

describe("weekSlots", () => {
  it("до 7 постов — все в лучший час", () => {
    const slots = weekSlots(5, 19);
    expect(slots).toHaveLength(5);
    for (const s of slots) expect(s).toMatch(/T19:00:00\+03:00$/);
  });
  it("больше 7 — часы разведены по окну 9–21", () => {
    const slots = weekSlots(14, 19);
    expect(slots).toHaveLength(14);
    for (const s of slots) {
      const hour = Number(s.slice(11, 13));
      expect(hour).toBeGreaterThanOrEqual(9);
      expect(hour).toBeLessThanOrEqual(21);
    }
  });
  it("формат ISO с датой YYYY-MM-DD", () => {
    const [slot] = weekSlots(1, 19);
    expect(slot).toMatch(/^\d{4}-\d{2}-\d{2}T19:00:00\+03:00$/);
  });
});

describe("periodSlots", () => {
  it("spreads a three-month plan across the complete 12-week horizon", () => {
    const slots = periodSlots(84, 12, 19);
    expect(slots).toHaveLength(84);
    const first = Date.parse(slots[0]);
    const last = Date.parse(slots.at(-1));
    expect((last - first) / 86_400_000).toBeGreaterThanOrEqual(82);
  });

  it("keeps multiple same-day posts separated inside the daytime window", () => {
    const slots = periodSlots(90, 12, 19);
    expect(slots).toHaveLength(90);
    const grouped = new Map();
    for (const slot of slots) {
      const date = slot.slice(0, 10);
      grouped.set(date, [...(grouped.get(date) || []), slot]);
    }
    for (const daySlots of grouped.values()) {
      const hours = daySlots.map((slot) => Number(slot.slice(11, 13)));
      expect(new Set(hours).size).toBe(hours.length);
      expect(Math.min(...hours)).toBeGreaterThanOrEqual(9);
      expect(Math.max(...hours)).toBeLessThanOrEqual(21);
    }
  });
});

describe("mapConcurrent", () => {
  it("сохраняет порядок по индексу", async () => {
    const out = await mapConcurrent([1, 2, 3, 4, 5], 2, async (x) => x * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });
  it("передаёт индекс вторым аргументом", async () => {
    const out = await mapConcurrent(["a", "b"], 2, async (x, i) => `${i}:${x}`);
    expect(out).toEqual(["0:a", "1:b"]);
  });
  it("пустой массив — пустой результат", async () => {
    expect(await mapConcurrent([], 3, async (x) => x)).toEqual([]);
  });
  it("реально параллелит (быстрее последовательного)", async () => {
    const start = Date.now();
    await mapConcurrent([1, 2, 3, 4], 4, async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 1;
    });
    // Последовательно было бы ~120мс; параллельно — порядка 30мс.
    expect(Date.now() - start).toBeLessThan(110);
  });
});

describe("autopilotBuildComplete", () => {
  const topics = [{ topic: "Один" }, { topic: "Два" }];
  const items = [
    { aiReady: true, draft: "Готовый первый пост", qualityBlocked: false, quality: { passed: true } },
    { aiReady: true, draft: "Готовый второй пост", qualityBlocked: false, quality: { passed: true } },
  ];

  it("принимает только план точного размера с готовыми ИИ-текстами", () => {
    expect(autopilotBuildComplete(2, topics)).toBe(true);
    expect(autopilotBuildComplete(2, topics, items)).toBe(true);
  });

  it("не принимает неполный список тем", () => {
    expect(autopilotBuildComplete(3, topics)).toBe(false);
  });

  it("не принимает пустой ИИ-черновик", () => {
    expect(autopilotBuildComplete(2, topics, [items[0], { aiReady: false, draft: "" }])).toBe(false);
  });

  it("не отдаёт пользователю план с постом, который Аврора сама заблокировала", () => {
    const blocked = {
      aiReady: true,
      draft: "Слабый черновик",
      qualityBlocked: true,
      quality: { passed: false, score: 65, threshold: 95 },
    };
    expect(autopilotBuildComplete(2, topics, [items[0], blocked])).toBe(false);
  });

  it("shows review-required drafts only through the confirmation-mode boundary", () => {
    const blocked = {
      aiReady: true,
      draft: "Черновик для ручной проверки",
      qualityBlocked: true,
      reviewRequired: true,
      quality: { passed: false },
    };
    expect(autopilotBuildComplete(2, topics, [items[0], blocked])).toBe(false);
    expect(autopilotDraftsDeliverable(2, topics, [items[0], blocked])).toBe(true);
    expect(autopilotDraftsDeliverable(2, topics, [items[0], {
      ...blocked,
      reviewRequired: false,
    }])).toBe(false);
  });
});

describe("autopilotJobAttemptsExhausted", () => {
  it("only terminalizes an Autopilot placeholder after the final BullMQ attempt", () => {
    expect(autopilotJobAttemptsExhausted(1, 2)).toBe(false);
    expect(autopilotJobAttemptsExhausted(2, 2)).toBe(true);
    expect(autopilotJobAttemptsExhausted(3, 2)).toBe(true);
  });
});

describe("autopilotJobTerminalFailure", () => {
  it("recognizes BullMQ max-stalled failure even when attemptsMade stays at zero", () => {
    expect(autopilotJobTerminalFailure(0, 2, "job stalled more than allowable limit")).toBe(true);
    expect(autopilotJobTerminalFailure(0, 2, "temporary provider error")).toBe(false);
    expect(autopilotJobTerminalFailure(2, 2, "provider error")).toBe(true);
  });
});

describe("boundedAutopilotRewriteAttempts", () => {
  it("preserves an explicit zero and caps excessive rewrites", () => {
    expect(boundedAutopilotRewriteAttempts(0)).toBe(0);
    expect(boundedAutopilotRewriteAttempts(1)).toBe(1);
    expect(boundedAutopilotRewriteAttempts(3)).toBe(2);
    expect(boundedAutopilotRewriteAttempts(undefined)).toBe(1);
  });
});

describe("plural", () => {
  const p = (n) => plural(n, "пост", "поста", "постов");
  it("русские формы", () => {
    expect(p(1)).toBe("пост");
    expect(p(2)).toBe("поста");
    expect(p(5)).toBe("постов");
    expect(p(0)).toBe("постов");
  });
  it("исключения 11–14 и окончание на 1", () => {
    expect(p(11)).toBe("постов");
    expect(p(21)).toBe("пост");
    expect(p(104)).toBe("поста");
  });
});

describe("toTelegramHtml", () => {
  it("экранирует спецсимволы", () => {
    expect(toTelegramHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });
  it("жирный и спойлер", () => {
    expect(toTelegramHtml("**жирный**")).toBe("<b>жирный</b>");
    expect(toTelegramHtml("||спойлер||")).toBe("<tg-spoiler>спойлер</tg-spoiler>");
  });
});

describe("keyboard", () => {
  it("undefined без кнопок", () => {
    expect(keyboard(undefined)).toBeUndefined();
    expect(keyboard([])).toBeUndefined();
  });
  it("callback-кнопка", () => {
    expect(keyboard([[{ text: "Да", data: "yes" }]])).toEqual({
      inline_keyboard: [[{ text: "Да", callback_data: "yes" }]],
    });
  });
  it("url-кнопка", () => {
    expect(keyboard([[{ text: "Открыть", url: "https://x" }]])).toEqual({
      inline_keyboard: [[{ text: "Открыть", url: "https://x" }]],
    });
    expect(keyboard([[{ text: "Кабинет", webApp: "https://app.example/bot" }]])).toEqual({
      inline_keyboard: [[{ text: "Кабинет", web_app: { url: "https://app.example/bot" } }]],
    });
  });
});

describe("decodeEntities", () => {
  it("именованные сущности", () => {
    expect(decodeEntities("&amp; &lt; &gt; &quot; &#39;")).toBe('& < > " \'');
  });
  it("числовой код символа", () => {
    expect(decodeEntities("&#1055;")).toBe("П");
  });
  it("обычный текст не меняется", () => {
    expect(decodeEntities("обычный текст")).toBe("обычный текст");
  });
});

describe("formatPost", () => {
  it("пустой и null-вход возвращает как есть", () => {
    expect(formatPost("")).toBe("");
    expect(formatPost(null)).toBe(null);
    expect(formatPost(undefined)).toBe(undefined);
  });

  it("схлопывает лишние пустые строки", () => {
    expect(formatPost("Абзац один.\n\n\n\nАбзац два.")).toBe("Абзац один.\n\nАбзац два.");
  });

  it("короткий текст с абзацами не меняется", () => {
    const t = "Хук.\n\nСередина поста.\n\nФинал.";
    expect(formatPost(t)).toBe(t);
  });

  it("режет «простыню» по границам предложений", () => {
    // 4 предложения по ~120 знаков — суммарно сильно больше 300.
    const s1 = "Первое предложение поста, которое само по себе уже достаточно длинное и занимает почти целую строку.";
    const s2 = "Второе предложение продолжает мысль и тоже не отличается краткостью, как это часто бывает в текстах.";
    const s3 = "Третье предложение добавляет конкретики, чтобы читатель не потерял нить рассуждения автора.";
    const s4 = "Четвёртое предложение завершает абзац и подводит читателя к какому-то выводу.";
    const wall = `${s1} ${s2} ${s3} ${s4}`;
    const out = formatPost(wall);
    const blocks = out.split("\n\n");
    expect(blocks.length).toBeGreaterThan(1);
    // Каждый блок короче лимита и все предложения на месте.
    for (const b of blocks) expect(b.length).toBeLessThanOrEqual(300);
    expect(out.replace(/\n/g, " ")).toContain(s1);
    expect(out.replace(/\n/g, " ")).toContain(s4);
  });

  it("не режет одно длинное предложение (некуда)", () => {
    const one = "Одно очень длинное предложение " + "со словами ".repeat(60) + "без единой точки.";
    expect(formatPost(one)).toBe(one.trim());
  });

  it("списки внутри блока не склеивает", () => {
    const t = "Вступление.\n\n— пункт один\n— пункт два\n— пункт три\n\nФинал.";
    expect(formatPost(t)).toBe(t);
  });

  it("хэштеги отрывает в отдельный блок", () => {
    const t = "Текст поста.\n#право #банкротство";
    expect(formatPost(t)).toBe("Текст поста.\n\n#право #банкротство");
  });

  it("хэштеги в середине поста тоже становятся блоком", () => {
    const t = "Часть один.\n#тег1\nЧасть два.";
    const out = formatPost(t);
    expect(out).toBe("Часть один.\n\n#тег1\n\nЧасть два.");
  });

  it("crlf нормализуется", () => {
    expect(formatPost("А.\r\n\r\nБ.")).toBe("А.\n\nБ.");
  });

  it("жирная разметка ** не ломается при резке", () => {
    const t = "Хук.\n\n**Ключевая мысль поста.** Пояснение к ней.";
    expect(formatPost(t)).toBe(t);
  });

  it("хэштеги, прилипшие к концу предложения, отрывает", () => {
    const t = "А какой шаг сделаете вы? #бизнес #налоги";
    expect(formatPost(t)).toBe("А какой шаг сделаете вы?\n\n#бизнес #налоги");
  });

  it("режет простыню даже если она короче лимита знаков, но длиннее 3 предложений", () => {
    // 6 коротких предложений (~150 знаков) — по знакам влезает, по предложениям нет.
    const wall = "Раз. Два. Три. Четыре. Пять. Шесть.";
    const out = formatPost(wall);
    const blocks = out.split("\n\n");
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toBe("Раз. Два. Три.");
    expect(blocks[1]).toBe("Четыре. Пять. Шесть.");
  });

  it("строки-списки из простыни не теряются", () => {
    const t = "Вот шаги.\n— первый шаг\n— второй шаг";
    expect(formatPost(t)).toBe("Вот шаги.\n\n— первый шаг\n— второй шаг");
  });
});
