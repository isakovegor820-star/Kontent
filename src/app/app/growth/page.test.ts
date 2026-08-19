import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const studio = readFileSync(new URL("../studio/page.tsx", import.meta.url), "utf8");
const autopilot = readFileSync(new URL("../autopilot/page.tsx", import.meta.url), "utf8");

describe("growth page contract", () => {
  it("shows diagnosis, weekly moves, do button and last week without promising growth", () => {
    expect(source).toContain("Что сейчас слабо");
    expect(source).toContain("Три хода на неделю");
    expect(source).toContain("Сделать");
    expect(source).toContain("Что было на прошлой неделе");
    expect(source).not.toContain("вырастешь");
    expect(source).not.toContain("+12%");
    expect(source).toContain("/api/growth?channel=");
    expect(source).toContain("import type { GrowthBoard");
  });

  it("opens Studio and Autopilot by move id, not by putting the prompt in the URL", () => {
    expect(studio).toContain('searchParams.get("growthMove")');
    expect(studio).toContain("/api/growth/moves/");
    expect(studio).toContain("setDraft(body.move.prompt)");
    expect(autopilot).toContain('window.location.search).get("growthMove")');
    expect(autopilot).toContain("/api/growth/moves/");
    expect(studio).not.toContain("prompt=");
    expect(autopilot).not.toContain("prompt=");
  });
});
