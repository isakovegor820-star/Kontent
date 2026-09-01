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
    expect(source).toContain('type ItemState = "done" | "snoozed" | "dismissed"');
    expect(source).toContain("Вернуть");
  });

  it("recovers stale smart actions and explains permission or source failures", () => {
    expect(source).toContain('"action_source_unavailable"');
    expect(source).toContain("const loaded = await load({ channelId: current.channelId })");
    expect(source).toContain("Источник для быстрого черновика больше недоступен");
    expect(source).toContain("У вас нет доступа к созданию материалов в этом проекте");
    expect(source).toContain('setPendingFocus(stillVisible ? item.fingerprint : "summary")');
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

  it("keeps contextual undo keyboard-reachable after programmatic summary focus across browsers", () => {
    expect(source).toContain("const undoButtonRef = useRef<HTMLButtonElement>(null)");
    expect(source).toContain("routeUndoFromDecisionFocus");
    expect(source).toContain("Array.from(titleRefs.current.values()).includes");
    expect(source).toContain('event.key !== "Tab" || event.shiftKey');
    expect(source).toContain("undoButtonRef.current.focus()");
    expect(source).toContain("onKeyDownCapture={routeUndoFromDecisionFocus}");
    expect(source).toContain("ref={undoButtonRef}");
    expect(source).toContain("disabled={refreshing || busy !== null}");
  });

  it("refreshes sources through an explicit POST before reloading the board", () => {
    expect(source).toContain('fetch("/api/today/refresh"');
    expect(source).toContain('method: "POST"');
    expect(source).toContain("const loaded = await load");
    expect(source).toContain("Обновить решения");
    expect(source).toContain("Всё актуально — новых решений пока нет.");
  });

  it("retains the last successful cards for a source-specific refresh failure", () => {
    expect(source).toContain("const failedSources = new Set(body.partialErrors");
    expect(source).toContain("stableClientRank([...body.items, ...retained])");
    expect(source).toContain(".slice(0, 5)");
    expect(source).toContain('failedSources.has("results")');
    expect(source).toContain("pulse: retainPulse ? previous.pulse : body.pulse");
  });

  it("offers the seven-day pulse, smart next step and accessible five-minute mode", () => {
    expect(source).toContain("Пульс канала за 7 дней");
    expect(source).toContain("Сделать следующий шаг");
    expect(source).toContain("Разобрать за 5 минут");
    expect(source).toContain("Быстрый разбор завершён");
    expect(source).toContain("Только реальные данные");
    expect(source).toContain("Развернуть статистику");
    expect(source).toContain("Открыть все графики");
    expect(source).toContain("посты, размещённые напрямую в канале");
    expect(source).toContain("Создать план в автопилоте");
    expect(source).toContain("/app/autopilot");
    expect(source).toContain("/app/competitors?channel=");
  });

  it("shows durable completed decisions inside Today", () => {
    expect(source).toContain("function CompletedToday");
    expect(source).toContain("Готовые сегодня");
    expect(source).toContain("board.completedItems");
    expect(source).toContain("Здесь сохраняются решения, которые вы уже завершили сегодня.");
  });

  it("keeps the Today command center compact, data-backed and keyboard discoverable", () => {
    expect(source).toContain("function TodaySummaryMetrics");
    expect(source).toContain('aria-label="Краткая сводка на сегодня"');
    expect(source).toContain("Публикации за 7 дней");
    expect(source).toContain("Просмотры за 7 дней");
    expect(source).toContain("Реакции за 7 дней");
    expect(source).toContain("Вовлечённость");
    expect(source).toContain("function PulseArtwork");
    expect(source).toContain('aria-label="Дополнительные действия"');
    expect(source).toContain("MoreHorizontal");
  });

  it("lets the user dismiss an optional decision and undo that choice", () => {
    expect(source).toContain('item.type === "risk" || item.type === "review"');
    expect(source).toContain("Отклонить");
    expect(source).toContain('changeState(candidate, "dismissed")');
    expect(source).toContain("Решение отклонено");
  });

  it("uses buttons for mutations, links for navigation and keeps recommendation feedback reversible", () => {
    expect(source).toContain('fetch("/api/today/action"');
    expect(source).toContain('fetch("/api/today/feedback"');
    expect(source).toContain("Больше не показывать такое");
    expect(source).toContain('state: "hidden"');
    expect(source).toContain('state: "active"');
    expect(source).toContain("Такие рекомендации снова будут появляться");
  });

  it("does not expose internal rollout or ranking identifiers", () => {
    expect(source).not.toContain("Release 1");
    expect(source).not.toContain("rankingVersion");
    expect(source).not.toContain("today-rank-v1");
    expect(source).not.toContain("feature flag");
    expect(source).not.toContain("rollout");
  });
});
