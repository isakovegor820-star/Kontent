import { describe, expect, it } from "vitest";
import { pickStudioCommand } from "./studio-command";

describe("pickStudioCommand", () => {
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
