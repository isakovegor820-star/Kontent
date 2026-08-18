import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./admin-bot-center.tsx", import.meta.url), "utf8");

describe("AdminBotCenter interface contract", () => {
  it("shows live connection, usage and per-user observability", () => {
    expect(source).toContain("Бот принимает сообщения");
    expect(source).toContain("Кто и как использует бот");
    expect(source).toContain("Как работают с ботом");
    expect(source).toContain("Последние команды, кнопки и типы сообщений");
    expect(source).toContain("user.lastInteractionAt");
  });

  it("explains the privacy boundary and announces dynamic state", () => {
    expect(source).toContain("Тексты сообщений, идентификаторы кнопок и токены не сохраняются");
    expect(source).toContain('role="status" aria-live="polite"');
    expect(source).toContain('role="alert"');
    expect(source).toContain('aria-labelledby="bot-interactions-title"');
  });

  it("keeps status and charts understandable without relying on color alone", () => {
    expect(source).toContain("INTERACTION_TYPE_LABEL");
    expect(source).toContain("aria-label={`${date}: действия");
    expect(source).toContain("state === \"healthy\" ? CheckCircle2");
    expect(source).toContain("Приём сообщений работает");
  });
});
