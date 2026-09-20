import { describe, expect, it } from "vitest";
import { looksLikeStudioEditFollowUp, pickStudioCommand } from "./studio-command";

describe("pickStudioCommand", () => {
  it("recognizes Cyrillic follow-ups and the exact shorten button wording", () => {
    expect(pickStudioCommand("Сделай короче")).toBe("shorten");
    expect(looksLikeStudioEditFollowUp("Убери последнее предложение")).toBe(true);
    expect(looksLikeStudioEditFollowUp("Сделай яснее")).toBe(true);
    expect(looksLikeStudioEditFollowUp("Безопасность информации")).toBe(false);
    expect(looksLikeStudioEditFollowUp("Сделай новый пост про конференцию")).toBe(false);
    expect(looksLikeStudioEditFollowUp("Сделай пост про конференцию")).toBe(false);
  });
  it("не превращает пост с вопросом в опрос", () => {
    expect(pickStudioCommand("Напиши короткий пост и добавь вопрос в конце")).toBe("write");
  });

  it("распознаёт явно запрошенный опрос", () => {
    expect(pickStudioCommand("Сделай опрос о конференции")).toBe("poll");
    expect(pickStudioCommand("Предложи варианты для голосования")).toBe("poll");
  });

  it("сохраняет остальные быстрые форматы", () => {
    expect(pickStudioCommand("Составь контент-план на неделю")).toBe("plan");
    expect(pickStudioCommand("Перепиши последний текст")).toBe("rewrite");
    expect(pickStudioCommand("Придумай сценарий видео")).toBe("script");
  });
});
