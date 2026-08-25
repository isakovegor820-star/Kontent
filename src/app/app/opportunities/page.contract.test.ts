import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("opportunities page states", () => {
  it("routes a missing channel to a recoverable settings action", () => {
    expect(source).toContain('status === "no_channel"');
    expect(source).toContain('href="/app/settings?section=channels"');
    expect(source).toContain("Подключить канал");
    expect(source).not.toContain("Release 1 разворачивается");
  });

  it("preserves ready data when a background refresh fails", () => {
    expect(source).toContain("Показаны ранее загруженные данные");
    expect(source).toContain('status === "ready" && operationError');
    expect(source).not.toContain('setStatus("error")');
  });
});
