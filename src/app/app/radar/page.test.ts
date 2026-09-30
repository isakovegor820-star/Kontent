import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("radar search interface contract", () => {
  const source = readFileSync(new URL("./radar-inner.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

  it("keeps local results honest when the external search degrades", () => {
    // Частичный/неуспешный внешний поиск не выдаёт локальные результаты за полные.
    expect(source).toContain("Интернет-поиск недоступен. Показываю результаты из базы.");
    expect(source).toContain("Не удалось расширить поиск. Локальные результаты сохранены.");
    expect(source).toContain("Поиск в интернете временно недоступен.");
  });

  it("surfaces run states and queue degradation without pretending", () => {
    expect(source).toContain('run.status === "partial"');
    expect(source).toContain('run.status === "failed"');
    expect(source).toContain('data?.error !== "queue_unavailable"');
    expect(source).toContain("EmptyState");
  });

  it("exposes search progress and saving affordances", () => {
    expect(source).toContain("progress");
    expect(source).toContain("alreadyAdded");
    expect(source).toContain("Сохранить");
  });

  it("mounts inside the platform shell", () => {
    expect(page).toContain("AppShell");
    expect(page).toContain("radar");
  });
});
