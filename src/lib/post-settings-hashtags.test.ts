// Авто-режим хэштегов обязан соблюдать норму площадки.
//
// Реальная генерация показала: при `hashtags: "auto"` на Telegram Аврора добавляла
// 3–5 хэштегов, хотя норма канала — 0. Валидатор это видел (блокер `hashtags`),
// а детерминированная финализация не исправляла, поэтому пост уезжал пользователю
// с нарушением. Тест фиксирует фактическое поведение на живых примерах.

import { describe, expect, it } from "vitest";

import { finalizePostSettingsDeterministically, validatePostSettingsResult } from "@/lib/post-settings";

const HASHTAGS = "#ТехнологИИПрава #LegalTech #Конференция";

const post = (tail: string) => [
  "Надёжный юрист объясняет риски простыми словами и показывает, что будет после каждого шага.",
  "",
  "Он разбирает документы клиента, а не пересказывает нормы, и фиксирует объём работы в договоре.",
  "",
  tail,
].join("\n");

describe("хэштеги в авто-режиме", () => {
  it("убирает хэштеги там, где площадка их не предполагает", () => {
    const settings = { version: 1, hashtags: "auto" };
    const result = finalizePostSettingsDeterministically(post(HASHTAGS), settings, { network: "tg" });
    expect(result).not.toContain("#");
    expect(result).toContain("Надёжный юрист объясняет риски");
    expect(result.endsWith("в договоре.")).toBe(true);
  });

  it("оставляет не больше нормы площадки", () => {
    const settings = { version: 1, hashtags: "auto" };
    const many = "#Право #Бизнес #Суд #Договор #Налоги #Стартап";

    // VK: авто-норма 5.
    const vk = finalizePostSettingsDeterministically(post(many), settings, { network: "vk" });
    const vkTags = vk.match(/#[\p{L}\p{N}_]+/gu) ?? [];
    expect(vkTags).toHaveLength(5);
    expect(vkTags[0]).toBe("#Право");

    // YouTube: авто-норма 3.
    const youtube = finalizePostSettingsDeterministically(post(many), settings, { network: "youtube" });
    const youtubeTags = youtube.match(/#[\p{L}\p{N}_]+/gu) ?? [];
    expect(youtubeTags).toHaveLength(3);
    expect(youtubeTags).toEqual(["#Право", "#Бизнес", "#Суд"]);
  });

  it("не трогает пост, который уже укладывается в норму", () => {
    const settings = { version: 1, hashtags: "auto" };
    const source = post("#Право #Бизнес #Суд");
    expect(finalizePostSettingsDeterministically(source, settings, { network: "vk" })).toBe(source);
  });

  it("после финализации валидатор больше не видит нарушения по хэштегам", () => {
    const settings = { version: 1, hashtags: "auto" };
    const source = post(HASHTAGS);
    const before = validatePostSettingsResult(source, settings, { network: "tg" });
    expect(before.violations.some((item) => item.code === "hashtags")).toBe(true);

    const fixed = finalizePostSettingsDeterministically(source, settings, { network: "tg" });
    const after = validatePostSettingsResult(fixed, settings, { network: "tg" });
    expect(after.violations.some((item) => item.code === "hashtags")).toBe(false);
  });

  it("явные режимы «без хэштегов» и «точное количество» работают как раньше", () => {
    const source = post(HASHTAGS);
    const none = finalizePostSettingsDeterministically(source, { version: 1, hashtags: "none" }, { network: "vk" });
    expect(none).not.toContain("#");

    const exact = finalizePostSettingsDeterministically(source, { version: 1, hashtags: "custom", hashtagCount: 3 }, { network: "vk" });
    expect((exact.match(/#[\p{L}\p{N}_]+/gu) ?? []).length).toBe(3);
  });
});
