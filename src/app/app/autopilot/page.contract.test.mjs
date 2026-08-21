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
    expect(source).toContain("attempt.candidateCount");
    expect(source).toContain("Резерв автоматически не публикуется");
    expect(source).toContain("plannedCandidateCount");
  });

  it("keeps the active plan visible and offers cause-specific repair actions", () => {
    expect(source).toContain("data.activePlan ?? data.plan");
    expect(source).toContain("Текущий готовый план остаётся доступен ниже");
    expect(source).toContain("Дополнить ${repairCount}");
    expect(source).toContain("Добавить материалы");
    expect(source).toContain("Открыть настройки качества");
    expect(source).toContain("Проверить {Math.max(1, attempt.progress.reviewRequired)}");
    expect(source).toContain("/api/autopilot/repair");
    expect(source).toContain("repairBusy");
  });

  it("waits for each poll to finish and reports generation/cancel network failures", () => {
    expect(source).not.toContain("setInterval(load, 3000)");
    expect(source).toContain("setTimeout(poll, 3000)");
    expect(source).toContain("Не удалось запустить сборку");
    expect(source).toContain("Не удалось остановить сборку");
  });

  it("shows only reader-ready publication states instead of validator diagnostics", () => {
    expect(source).toContain("готов к просмотру");
    expect(source).toContain("на согласовании");
    expect(source).toContain("isAutopilotReaderReadyItem(item)");
    expect(source).not.toContain("Источники и контекст");
    expect(source).toContain("Открыть в редакторе");
    expect(source).toContain('from: "autopilot"');
    expect(source).toContain('type="range"');
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

  it("announces progress and errors without forcing motion", () => {
    expect(source).toContain('role={terminal ? "alert" : "status"}');
    expect(source).toContain('aria-live={terminal ? "assertive" : "polite"}');
    expect(source).toContain("useReducedMotion()");
    expect(source).toContain("autopilotBuildSpinnerClass(reducedMotion)");
    expect(source).toContain("motion-reduce:transition-none");
    expect(source).toContain("tabular-nums");
  });
});
