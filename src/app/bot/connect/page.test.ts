import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("Telegram connection confirmation screen", () => {
  it("keeps the one-time secret out of the request URL and preserves it across login", () => {
    expect(page).toContain("window.location.hash");
    expect(page).toContain("window.sessionStorage.setItem");
    expect(page).toContain('action: "inspect"');
    expect(page).toContain('"/login?next=%2Fbot%2Fconnect"');
  });

  it("uses explicit action and consequence labels", () => {
    expect(page).toContain("Подключить этот чат");
    expect(page).toContain("Перенести подключение");
    expect(page).toContain("Этот чат уже связан с другим аккаунтом");
    expect(page).toContain('role="alert"');
    expect(page).toContain('aria-live="polite"');
  });
});
