import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Today page resilience and interface contract", () => {
  const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

  it("refreshes on project changes and sends the selected channel to the API", () => {
    expect(source).toContain('window.addEventListener("aurora:project-changed"');
    expect(source).toContain('`/api/today${query}`');
    expect(source).toContain('params.set("channel", String(channelId))');
    expect(source).toContain("activeController.current?.abort()");
  });

  it("keeps action failures local and offers an accessible undo", () => {
    expect(source).toContain("setItemErrors");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('state: "active" | ItemState');
    expect(source).toContain('type ItemState = "done" | "snoozed"');
    expect(source).toContain("Вернуть");
  });

  it("covers loading, onboarding, partial, unavailable and completed states", () => {
    expect(source).toContain("Собираем решения на сегодня");
    expect(source).toContain("Подключите канал");
    expect(source).toContain("Не все источники обновились");
    expect(source).toContain("Источники решений временно недоступны");
    expect(source).toContain("На сегодня всё выполнено");
  });

  it("optimistically removes items, rolls them back on error and restores focus", () => {
    expect(source).toContain("items: current.items.filter");
    expect(source).toContain("Карточка возвращена");
    expect(source).toContain("setPendingFocus(item.fingerprint)");
    expect(source).toContain("titleRefs.current.get(pendingFocus)");
  });

  it("refreshes sources through an explicit POST before reloading the board", () => {
    expect(source).toContain('fetch("/api/today/refresh"');
    expect(source).toContain('method: "POST"');
    expect(source).toContain("const loaded = await load");
    expect(source).toContain("Обновить решения");
  });

  it("retains the last successful cards for a source-specific refresh failure", () => {
    expect(source).toContain("const failedSources = new Set(body.partialErrors");
    expect(source).toContain("stableClientRank([...body.items, ...retained])");
    expect(source).toContain(".slice(0, 5)");
  });

  it("does not expose internal rollout or ranking identifiers", () => {
    expect(source).not.toContain("Release 1");
    expect(source).not.toContain("rankingVersion");
    expect(source).not.toContain("today-rank-v1");
    expect(source).not.toContain("feature flag");
    expect(source).not.toContain("rollout");
  });
});
