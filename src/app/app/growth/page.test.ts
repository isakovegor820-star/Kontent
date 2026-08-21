import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const studio = readFileSync(new URL("../studio/page.tsx", import.meta.url), "utf8");
const autopilot = readFileSync(new URL("../autopilot/page.tsx", import.meta.url), "utf8");

describe("growth page contract", () => {
  it("shows trajectory, primary move, evidence and measured history without promising growth", () => {
    expect(source).toContain("Траектория недели");
    expect(source).toContain("Главный ход недели");
    expect(source).toContain("Почему Аврора так решила");
    expect(source).toContain("Результаты прошлой недели");
    expect(source).toContain("Чему Аврора научилась");
    expect(source).not.toContain("вырастешь");
    expect(source).not.toContain("+12%");
    expect(source).toContain("/api/growth?channel=");
    expect(source).toContain("import type { GrowthBoard");
  });

  it("opens Studio and Autopilot by move id, not by putting the prompt in the URL", () => {
    expect(studio).toContain('searchParams.get("growthMove")');
    expect(studio).toContain("/api/growth/moves/");
    expect(studio).toContain("setDraft(body.move.prompt)");
    expect(studio).toContain("growthMoveId: growthMoveIdRef.current");
    expect(autopilot).toContain('window.location.search).get("growthMove")');
    expect(autopilot).toContain("/api/growth/moves/");
    expect(autopilot).toContain("growthMoveId,");
    expect(studio).not.toContain("prompt=");
    expect(autopilot).not.toContain("prompt=");
  });

  it("uses native navigation, action-specific labels and an announced busy region", () => {
    expect(source).toContain("href={move.actionHref}");
    expect(source).not.toMatch(/<Link[^>]*>\s*<Button/gu);
    expect(source).toContain("Создать пост по сигналу");
    expect(source).toContain("Собрать план недели");
    expect(source).toContain("Создать пост об услуге");
    expect(source).toContain("Ответить аудитории");
    expect(source).not.toContain("Отметить ход сделанным");
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-busy={loading}');
    expect(source).toContain('role="region" aria-busy={loading}');
    expect(source).toContain("Загружаем траекторию выбранного канала.");
    expect(source).toContain("disabled={busyId !== null}");
  });
});
