import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("competitor dossier interface contract", () => {
  const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

  it("explains empty and dead states without fake data", () => {
    expect(source).toContain("Досье не найдено");
    expect(source).toContain("Досье собрать не из чего");
    expect(source).toContain('c.status === "error"');
    expect(source).toContain('c.status === "no_feed"');
  });

  it("differentiates Telegram public data from Instagram business data", () => {
    expect(source).toContain('c.network === "instagram"');
    expect(source).toContain("Разведка по открытым данным Telegram");
    expect(source).toContain("Meta API");
  });

  it("renders only measured analytics sections", () => {
    // Ритм, медиа, длина и «залёты» считаются из собранных данных, а не констант.
    expect(source).toContain("rhythm.byWeekday");
    expect(source).toContain("rhythm.byHour");
    expect(source).toContain("mediaMix");
    expect(source).toContain("lengthBuckets");
    expect(source).toContain("hitAnatomy");
  });

  it("navigates back to the competitor list", () => {
    expect(source).toContain("/app/competitors");
    expect(source).toContain("К конкурентам");
  });
});
