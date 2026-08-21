import { describe, expect, it } from "vitest";
import { selectAutopilotNewsSources } from "./autopilot-source-selection";

describe("Autopilot source selection", () => {
  it("derives a bounded crypto news perimeter from the confirmed channel brief", () => {
    const sources = selectAutopilotNewsSources({
      niche: "Криптовалюты, Web3 и цифровые активы",
      audience: "Люди, которые хотят понимать рынок без трейдерского жаргона",
      goal: "Объяснять важные новости и события",
      rubrics: ["Новости", "Понятный разбор"],
      formats: ["Новость с авторским выводом"],
    });

    expect(sources).toHaveLength(6);
    expect(sources.slice(0, 3).map((source) => source.id)).toEqual([
      "coindesk",
      "cointelegraph",
      "decrypt",
    ]);
  });
});
