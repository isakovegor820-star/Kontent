// Тесты профиля канала (невидимая база знаний). Хрупкое место — разбор ответа модели:
// модели оборачивают JSON в прозу и markdown, а этот текст ляжет в базу как ФАКТЫ.
import { describe, it, expect } from "vitest";
import {
  PROFILE_FIELDS,
  emptyProfile,
  normalizeProfile,
  isMeaningfulProfile,
  buildExtractionMessages,
  parseProfile,
  profileToSourceText,
  profileFromInterview,
} from "./channel-profile.mjs";

describe("normalizeProfile", () => {
  it("не-объект → пустой профиль", () => {
    for (const bad of [null, undefined, 42, "строка", []]) {
      expect(normalizeProfile(bad)).toEqual(emptyProfile());
    }
  });

  it("схлопывает пробелы и режет потолки", () => {
    const p = normalizeProfile({
      niche: `  много\n\nслов   ${"я".repeat(300)}`,
      services: "x".repeat(700),
      tone: "дружелюбно",
    });
    expect(p.niche.length).toBeLessThanOrEqual(220);
    expect(p.niche).not.toMatch(/\s{2}/);
    expect(p.services.length).toBe(600);
  });

  it("topics терпит и массив, и строку через запятую/точку с запятой", () => {
    expect(normalizeProfile({ topics: "йога, питание; сон" }).topics).toEqual([
      "йога",
      "питание",
      "сон",
    ]);
    expect(normalizeProfile({ topics: [" a ", "", null, "b"] }).topics).toEqual(["a", "b"]);
  });

  it("topics: не больше пяти и не длиннее 60 символов каждая", () => {
    const p = normalizeProfile({ topics: ["1", "2", "3", "4", "5", "6", "7"] });
    expect(p.topics).toHaveLength(5);
    expect(normalizeProfile({ topics: ["т".repeat(100)] }).topics[0]).toHaveLength(60);
  });
});

describe("isMeaningfulProfile", () => {
  it("пустой профиль бессмысленен", () => {
    expect(isMeaningfulProfile(emptyProfile())).toBe(false);
    expect(isMeaningfulProfile(null)).toBe(false);
  });
  it("ниша, услуги или хоть одна тема — уже смысл", () => {
    expect(isMeaningfulProfile({ ...emptyProfile(), niche: "йога" })).toBe(true);
    expect(isMeaningfulProfile({ ...emptyProfile(), services: "консультации" })).toBe(true);
    expect(isMeaningfulProfile({ ...emptyProfile(), topics: ["сон"] })).toBe(true);
  });
});

describe("parseProfile", () => {
  const good =
    '{"niche":"йога для занятых","topics":["йога","сон"],"services":"курс","prices":"4900₽/мес","audience":"женщины 30-45","tone":"тёплый","taboos":"без обещаний похудения","goal":"продажи"}';

  it("чистый JSON → профиль", () => {
    const p = parseProfile(good);
    expect(p.niche).toBe("йога для занятых");
    expect(p.topics).toEqual(["йога", "сон"]);
    expect(p.prices).toBe("4900₽/мес");
  });

  it("терпит markdown-обёртку ```json", () => {
    const p = parseProfile("Вот профиль:\n```json\n" + good + "\n```\nНадеюсь, помогло!");
    expect(p.niche).toBe("йога для занятых");
  });

  it("терпит прозу вокруг объекта", () => {
    const p = parseProfile(`Смотрю на посты… Итог: ${good} Готово.`);
    expect(p.niche).toBe("йога для занятых");
  });

  it("topics строкой через запятую → массив", () => {
    const p = parseProfile('{"niche":"психология","topics":"тревога, отношения"}');
    expect(p.topics).toEqual(["тревога", "отношения"]);
  });

  it("мусор / нет JSON → null", () => {
    expect(parseProfile("совсем не JSON")).toBeNull();
    expect(parseProfile("")).toBeNull();
    expect(parseProfile(null)).toBeNull();
    expect(parseProfile("{битый json")).toBeNull();
  });

  it("JSON без ниши → null (считаем сбоем, покажем интервью)", () => {
    expect(parseProfile('{"services":"консультации","prices":"1000"}')).toBeNull();
    expect(parseProfile("{}")).toBeNull();
  });
});

describe("buildExtractionMessages", () => {
  it("кладёт название канала, посты и запрет выдумывать", () => {
    const { system, user } = buildExtractionMessages("Йога с Аней", ["пост один", "пост два"]);
    expect(system).toContain("JSON");
    expect(user).toContain("Йога с Аней");
    expect(user).toContain("1. пост один");
    expect(user).toContain("НЕ выдумывай");
  });

  it("берёт не больше 15 постов и режет каждый до 500 символов", () => {
    const posts = Array.from({ length: 20 }, (_, i) => `пост ${i}`);
    const { user } = buildExtractionMessages("Канал", posts);
    expect(user).toContain("15. пост 14");
    expect(user).not.toContain("16. пост 15");
    const long = buildExtractionMessages("Канал", ["д".repeat(900)]);
    expect(long.user).not.toContain("д".repeat(501));
  });
});

describe("profileToSourceText", () => {
  it("каждое заполненное поле — отдельный абзац (граница куска индексатора)", () => {
    const text = profileToSourceText({
      ...emptyProfile(),
      niche: "йога",
      prices: "4900₽/мес",
      taboos: "без обещаний",
    });
    const parts = text.split("\n\n");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("Ниша канала: йога");
    expect(text).toContain("Цены и сроки: 4900₽/мес");
    expect(text).toContain("НЕ пишет");
    expect(text).not.toContain("Аудитория");
  });

  it("пустой профиль → пустой текст", () => {
    expect(profileToSourceText(emptyProfile())).toBe("");
  });
});

describe("profileFromInterview", () => {
  it("маппит ответы интервью в профиль", () => {
    const p = profileFromInterview({
      about: "канал о йоге для занятых",
      services: "онлайн-курс",
      prices: "4900₽",
      taboos: "не обещаю похудение",
      tone: "тёплый",
      goal: "продажи",
    });
    expect(p.niche).toBe("канал о йоге для занятых");
    expect(p.goal).toBe("продажи");
    expect(p.audience).toBe(""); // в интервью не спрашиваем — остаётся пустым честно
  });
});

describe("PROFILE_FIELDS", () => {
  it("8 полей, у каждого ключ/подпись/подсказка", () => {
    expect(PROFILE_FIELDS).toHaveLength(8);
    for (const f of PROFILE_FIELDS) {
      expect(f.key).toBeTruthy();
      expect(f.label).toBeTruthy();
      expect(f.hint).toBeTruthy();
    }
    expect(PROFILE_FIELDS.map((f) => f.key)).toContain("prices");
  });
});
