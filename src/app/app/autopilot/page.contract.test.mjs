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
    expect(source).toContain("plan?.buildProgress?.completed");
    expect(source).toContain("Остановить сборку");
    expect(source).toContain('method: "DELETE"');
  });

  it("waits for each poll to finish and reports generation/cancel network failures", () => {
    expect(source).not.toContain("setInterval(load, 3000)");
    expect(source).toContain("setTimeout(poll, 3000)");
    expect(source).toContain("Не удалось запустить сборку");
    expect(source).toContain("Не удалось остановить сборку");
  });

  it("shows an actionable publication state instead of an internal numeric score", () => {
    expect(source).toContain("готов к публикации");
    expect(source).toContain("нужна правка");
    expect(source).not.toContain("{it.quality.score}/{it.quality.threshold}");
    expect(source).not.toContain("Сырые тексты не сохранены");
  });

  it("uses real links styled as buttons without nested interactive controls", () => {
    expect(source).not.toMatch(/<Link\b[^>]*>\s*<Button\b/u);
    expect(source).toContain("buttonClassName");
  });
});
