import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const tokenHelper = readFileSync(new URL("../../../lib/bot-connect-token.ts", import.meta.url), "utf8");

describe("Telegram connection confirmation screen", () => {
  it("keeps the one-time secret out of the request URL and preserves it across login", () => {
    expect(page).toContain("consumeBotConnectionToken");
    expect(page).toContain("storage: window.sessionStorage");
    expect(tokenHelper).toContain("input.location.hash");
    expect(tokenHelper).toContain("input.history.replaceState");
    expect(tokenHelper).toContain("input.storage.setItem");
    expect(page).toContain('window.addEventListener("hashchange", readTokenAndInspect)');
    expect(page).toContain('window.removeEventListener("hashchange", readTokenAndInspect)');
    expect(page).toContain('action: "inspect"');
    expect(page).toContain('"/login?next=%2Fbot%2Fconnect"');
  });

  it("asks the API for the configured bot even when the link token is missing", () => {
    expect(page).toContain('token: token || ""');
    expect(page).not.toContain('if (!token) {\n      setView("invalid")');
  });

  it("uses explicit action and consequence labels", () => {
    expect(page).toContain("Подключить этот чат");
    expect(page).toContain("Перенести подключение");
    expect(page).toContain("Этот чат уже связан с другим аккаунтом");
    expect(page).toContain('role="alert"');
    expect(page).toContain('aria-live="polite"');
  });
});
