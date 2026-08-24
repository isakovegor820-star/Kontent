import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("./page.tsx", import.meta.url), "utf8");

describe("Autopilot build UI contract", () => {
  it("distinguishes loading from a recoverable API failure", () => {
    expect(source).toContain("if (!r.ok || !d)");
    expect(source).toContain("Не удалось загрузить Автопилот");
    expect(source).toContain("Повторить загрузку");
    expect(source).not.toContain("if (loading || !data)");
  });

  it("shows durable progress and lets the user stop a build", () => {
    expect(source).toContain('role="progressbar"');
    expect(source).toContain("attempt.readyCount");
    expect(source).toContain("data?.buildAttempt?.status");
    expect(source).toContain("Остановить сборку");
    expect(source).toContain('method: "DELETE"');
    expect(source).toContain("attempt.publicationTargetCount");
    expect(source).not.toContain("Резерв автоматически не публикуется");
    expect(source).not.toContain("кандидатов");
    expect(source).toContain("Требует внимания");
  });

  it("keeps the active plan visible while Autopilot owns internal repair", () => {
    expect(source).toContain("data.activePlan ?? data.plan");
    expect(source).toContain("Готовые тексты не пересобираются");
    expect(source).toContain("Добавить материалы");
    expect(source).toContain("Открыть настройки качества");
    expect(source).toContain("/api/autopilot/repair");
    expect(source).toContain("Готовые посты сохранены. Аврора работает только с недостающими");
    expect(source).not.toContain("Повторить 6 постов");
  });

  it("shows automatic provider recovery and never labels an empty plan as ready", () => {
    expect(source).toContain("ИИ временно не ответил");
    expect(source).toContain("недостающие Аврора продолжит собирать автоматически");
    expect(source).toContain("Готовых постов пока нет");
    expect(source).not.toContain("Эти посты сохранены");
    expect(source).toContain("Продолжить сборку");
    expect(source).toContain("const canContinue = attempt.retryableItemIndexes.length > 0");
    expect(source).toContain("Собрать план снова");
    expect(source).not.toContain("Собрать заново");
    expect(source).toContain("const hasUsablePlan = Boolean(plan && visible.length > 0)");
    expect(source).toContain("{!hasUsablePlan && !buildAttempt && (");
  });

  it("keeps quick settings behind a compact accessible dialog", () => {
    expect(source).toContain("Настроить посты");
    expect(source).toContain('aria-haspopup="dialog"');
    expect(source).toContain("dialog.showModal()");
    expect(source).toContain("Параметры следующего плана");
    expect(source).toContain('type="range"');
    expect(source).toContain("Сохранить параметры");
    expect(source).toContain("quick_settings: quickSettings");
    expect(source.match(/id="autopilot-horizon"/gu)).toHaveLength(1);
    expect(source).not.toContain("Почему такой план");
  });

  it("implements the Autopilot overview hierarchy from the approved design", () => {
    expect(source).toContain("Аврора создаёт контент, публикует и анализирует результаты.");
    expect(source).toContain("Контент создаётся и публикуется");
    expect(source).toContain("Расписание публикаций");
    expect(source).toContain("Последние публикации");
    expect(source).toContain("Смотреть полный календарь");
    expect(source).toContain("Опубликовано");
    expect(source).toContain("Просмотры");
    expect(source).toContain("Вовлечённость");
    expect(source).toContain('publication_origin === "autopilot"');
    expect(source).not.toContain("12.4K");
    expect(source).not.toContain("8.7%");
  });

  it("pauses and resumes through the real server setting", () => {
    expect(source).toContain('fetch("/api/autopilot/settings"');
    expect(source).toContain("Автопилот приостановлен");
    expect(source).toContain("Автопилот возобновлён");
    expect(source).toContain("Уже запланированные публикации остаются в календаре");
  });

  it("separates automatic mode from an explicit one-off plan build", () => {
    expect(source).toContain("Включить автопилот");
    expect(source).toContain("Собрать новый план");
    expect(source).not.toContain("Запустить автопилот");
    expect(source).toContain("onClick={generate}");
    expect(source).toContain("onToggle={() => void toggleAutopilot()}");
    expect(source).toContain("const shouldStartFirstPlan = enabled && !data.activePlan && !data.plan && !data.buildAttempt");
    expect(source).toContain("if (shouldStartFirstPlan)");
    expect(source).toContain("await generate()");
  });

  it("uses real scheduled posts as the calendar source and exposes data failures", () => {
    expect(source).toContain("const realScheduleItems");
    expect(source).toContain("Number(post.channel_id) === chId");
    expect(source).toContain('publication_origin === "autopilot"');
    expect(source).toContain("Не удалось обновить данные");
    expect(source).toContain("Не удалось загрузить публикации");
  });

  it("waits for each poll to finish and reports generation/cancel network failures", () => {
    expect(source).not.toContain("setInterval(load, 3000)");
    expect(source).toContain("setTimeout(poll, 3000)");
    expect(source).toContain("Не удалось запустить сборку");
    expect(source).toContain("Не удалось остановить сборку");
  });

  it("reads the Growth move deep link at generation time after hydration", () => {
    expect(source).not.toContain("const [growthMoveId] = useState");
    expect(source).toContain('window.location.search).get("growthMove")');
    expect(source).toContain("const growthMoveId = Number.isSafeInteger(growthMoveValue)");
    expect(source).toContain("growthMoveId,");
  });

  it("shows only reader-ready publication states instead of validator diagnostics", () => {
    expect(source).toContain("готов к просмотру");
    expect(source).toContain("на согласовании");
    expect(source).toContain("isAutopilotReaderReadyItem(item)");
    expect(source).not.toContain("Источники и контекст");
    expect(source).toContain("Открыть в редакторе");
    expect(source).toContain('from: "autopilot"');
    expect(source).toContain("!isAutopilotHumanReviewItem(item)");
    expect(source).toContain("!item.draftId && canApproveItem(item)");
    expect(source).toContain("Поставь пост в календарь оттуда");
    expect(source).toContain("max-w-[68ch]");
    expect(source).not.toContain("нужна правка");
    expect(source).not.toContain("Что здесь поправить");
    expect(source).not.toContain("{it.quality.score}/{it.quality.threshold}");
    expect(source).not.toContain("Сырые тексты не сохранены");
  });

  it("uses real links styled as buttons without nested interactive controls", () => {
    expect(source).not.toMatch(/<Link\b[^>]*>\s*<Button\b/u);
    expect(source).toContain("buttonClassName");
  });

  it("uses an accessible in-app confirmation for calendar scheduling", () => {
    expect(source).toContain("<ConfirmDialog");
    expect(source).toContain('confirmVariant="primary"');
    expect(source).not.toContain("window.confirm(");
    expect(source).not.toContain("window.alert(");
  });

  it("announces progress and errors without forcing motion", () => {
    expect(source).toContain('role={terminal ? "alert" : "status"}');
    expect(source).toContain('aria-live={terminal ? "assertive" : "polite"}');
    expect(source).toContain("useReducedMotion()");
    expect(source).toContain("autopilotBuildSpinnerClass(reducedMotion)");
    expect(source).toContain("motion-reduce:transition-none");
    expect(source).toContain("tabular-nums");
  });
});
