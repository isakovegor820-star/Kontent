import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("studio questions interface contract", () => {
  const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

  it("explains what the assistant does before the first interaction", () => {
    expect(source).toContain("Помощник по аудитории");
    expect(source).toContain("Не пропускайте комментарии");
    expect(source).toContain("подготовить ответ");
  });

  it("delegates the interactive surface to the shared assistant panel", () => {
    expect(source).toContain("AudienceAssistantPanel");
    expect(source).toContain("AppShell");
  });
});
