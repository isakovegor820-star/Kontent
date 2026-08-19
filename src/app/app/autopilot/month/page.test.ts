import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const planner = readFileSync(
  new URL("../../../../components/app/monthly-campaign-planner.tsx", import.meta.url),
  "utf8",
);
const studio = readFileSync(new URL("../../studio/page.tsx", import.meta.url), "utf8");

describe("monthly campaign page contract", () => {
  it("keeps the editorial-month purpose in the shell", () => {
    expect(source).toContain("Кампания на месяц");
    expect(source).toContain("Сетка тем на весь месяц");
  });

  it("opens Composer and Studio by campaign ids, not by putting the prompt in the URL", () => {
    expect(planner).toContain('destination === "studio"');
    expect(planner).toContain("monthlyCampaign");
    expect(planner).toContain("monthlyItem");
    expect(planner).toContain("/app/studio?");
    expect(planner).toContain("/app/composer?draft=");
    expect(planner).toContain("from=autopilot-month");
    expect(planner).toContain("Написать в редакторе");
    expect(planner).toContain("Подготовить в Студии");
    expect(planner).not.toContain("prompt=");
    expect(studio).toContain('searchParams.get("monthlyCampaign")');
    expect(studio).toContain('searchParams.get("monthlyItem")');
    expect(studio).toContain("/api/monthly-campaigns/");
    expect(studio).toContain("monthlyCampaignStudioPrompt");
    expect(studio).toContain("from=autopilot-month");
    expect(studio).not.toContain("prompt=");
  });
});
