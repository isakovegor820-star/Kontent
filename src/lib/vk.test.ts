// Тесты чистых парсеров VK API. Сетевые вызовы (vkApi/wall.post и т.д.) не тестируем —
// им нужен живой VK. Здесь — защитный разбор меняющихся форматов ответов VK.
import { describe, it, expect } from "vitest";
import { buildOwnerId, vkPostUrl, parseGroup, parsePostStats } from "./vk";

describe("buildOwnerId / vkPostUrl", () => {
  it("owner_id сообщества — отрицательный id", () => {
    expect(buildOwnerId(123456)).toBe("-123456");
  });
  it("публичная ссылка на пост", () => {
    expect(vkPostUrl(123456, 789)).toBe("https://vk.com/wall-123456_789");
  });
});

describe("parseGroup", () => {
  it("новая форма ответа { groups: [...] }", () => {
    const g = parseGroup({
      groups: [{ id: 111, name: "Кофе", screen_name: "corner_coffee", members_count: 5000 }],
    });
    expect(g).toEqual({ groupId: 111, name: "Кофе", screenName: "corner_coffee", membersCount: 5000 });
  });

  it("старая форма ответа — массив", () => {
    const g = parseGroup([{ id: 222, name: "X", screen_name: "x" }]);
    expect(g?.groupId).toBe(222);
    expect(g?.membersCount).toBeNull();
  });

  it("мусор — null", () => {
    expect(parseGroup(null)).toBeNull();
    expect(parseGroup({})).toBeNull();
    expect(parseGroup({ groups: [] })).toBeNull();
    expect(parseGroup({ groups: [{ name: "без id" }] })).toBeNull();
  });
});

describe("parsePostStats", () => {
  it("разбирает вложенные счётчики", () => {
    const m = parsePostStats({
      views: { count: 1200 },
      likes: { count: 30 },
      reposts: { count: 5 },
      comments: { count: 7 },
    });
    expect(m).toEqual({ views: 1200, reactions: 30, reposts: 5, comments: 7 });
  });

  it("отсутствующее поле — null, не 0", () => {
    const m = parsePostStats({ views: { count: 10 } });
    expect(m).toEqual({ views: 10, reactions: null, reposts: null, comments: null });
  });

  it("мусор — null", () => {
    expect(parsePostStats(null)).toBeNull();
    expect(parsePostStats("строка")).toBeNull();
  });
});
