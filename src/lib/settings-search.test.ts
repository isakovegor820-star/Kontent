import { describe, expect, it } from "vitest";
import { searchSettings, SETTINGS_SEARCH_ENTRIES } from "./settings-search";

describe("settings discovery", () => {
  it.each(["UTM-шаблоны", "шаблоны", "утм шаблон", "метки для ссылок", "шаблоны меток", "откуда приходят заявки", "UTM-шаблоны!!!", "шаблны"])("finds UTM by intent: %s", (query) => {
    expect(searchSettings(query).map((item) => item.id)).toContain("utm");
  });
  it.each([["как включить светлую тему", "appearance"], ["фото", "avatar"], ["юмор", "channel-humor"], ["короче текст", "channel-max-length"], ["хочу чтобы посты были короче", "channel-max-length"], ["автоматические публикации", "autopilot"], ["перенос между каналами", "copy"]])("finds %s", (query, id) => {
    expect(searchSettings(query).map((item) => item.id)).toContain(id);
  });
  it("ranks the exact setting first, preserves multiple meanings and rejects unrelated requests", () => {
    expect(searchSettings("UTM-шаблоны")[0].id).toBe("utm");
    expect(searchSettings("шаблон").map((entry) => entry.id)).toEqual(expect.arrayContaining(["utm", "blocks"]));
    expect(searchSettings("абракадабра космолет")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
    expect(new Set(SETTINGS_SEARCH_ENTRIES.map((entry) => entry.id)).size).toBe(SETTINGS_SEARCH_ENTRIES.length);
    expect(SETTINGS_SEARCH_ENTRIES.find((entry) => entry.id === "channel-autopilot-enabled")?.section).toBe("autopilot");
  });
});
