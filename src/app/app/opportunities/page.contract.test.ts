import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("opportunities page states", () => {
  it("routes a missing channel to a recoverable settings action", () => {
    expect(source).toContain('status === "no_channel"');
    expect(source).toContain('href="/app/settings?section=channels"');
    expect(source).toContain("Подключить канал");
    expect(source).not.toContain("Release 1 разворачивается");
  });

  it("preserves ready data when a background refresh fails", () => {
    expect(source).toContain("Показаны ранее загруженные данные");
    expect(source).toContain('status === "ready" && operationError');
    expect(source).not.toContain('setStatus("error")');
  });

  it("binds every request and recovery action to the selected channel", () => {
    expect(source).toContain("useChannelChoice(store.realChannels, requestedChannelId)");
    expect(source).toContain("`/api/opportunities?channel=${channelId}`");
    expect(source).toContain("item.channelId !== channelId");
    expect(source).toContain('href="/app/settings?section=content"');
    expect(source).toContain("без конкурентов и истории публикаций");
  });

  it("offers progressive disclosure without showing stale-state controls", () => {
    expect(source).toContain("<details");
    expect(source).toContain("Источник и методика");
    expect(source).toContain("Развернуть подробности");
    expect(source).not.toContain('epistemicState === "stale"');
  });

  it("lets the user undo an accidental not-relevant decision", () => {
    expect(source).toContain("Не подходит");
    expect(source).toContain("Отменить");
    expect(source).toContain('{ method: "DELETE" }');
  });
});
