import { describe, expect, it } from "vitest";
import { requiresBriefConfirmation } from "./brief-confirmation";

describe("requiresBriefConfirmation", () => {
  it("does not interrupt a concrete ordinary writing request", () => {
    expect(requiresBriefConfirmation({
      text: "Напиши анонс вебинара 12 августа для владельцев кофеен, сохрани дату и ссылку из брифа.",
      hasBlockers: false,
    })).toBe(false);
  });

  it.each([
    "П",
    "Пост",
    "Напиши пост",
    "Сделай мне пост",
  ])("allows a non-empty writing request of any length: %s", (text) => {
    expect(requiresBriefConfirmation({
      text,
      hasBlockers: false,
    })).toBe(false);
  });

  it.each([
    ["Подготовь разбор статьи 14 закона для клиентов", false, false],
    ["Подробный безопасный бриф с конфликтом настроек", true, false],
    ["Подробный безопасный бриф с внешним действием", false, true],
  ])("requires confirmation for legal risk, blockers or external action", (text, hasBlockers, externalAction) => {
    expect(requiresBriefConfirmation({ text, hasBlockers, externalAction })).toBe(true);
  });
});
