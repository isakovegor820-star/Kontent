import { describe, expect, it } from "vitest";

import { analyzeStyleSamples, splitStyleSamples } from "./style-training";

describe("style training", () => {
  it("splits at most five meaningful samples", () => {
    const samples = Array.from({ length: 7 }, (_, index) => `Пост номер ${index + 1}: содержательный текст для анализа.`).join("\n---\n");
    expect(splitStyleSamples(samples)).toHaveLength(5);
  });

  it("turns author examples into a safe style-only patch", () => {
    const result = analyzeStyleSamples(
      "Ты наверняка замечал это. Давай разберём спокойно 🙂\n\nКороткий вывод.\n---\nТы можешь проверить идею сегодня. Без лишнего шума.",
    );

    expect(result).not.toBeNull();
    expect(result?.confidence).toBe("medium");
    expect(result?.patch.address).toBe("ты");
    expect(result?.patch.styleExamples).toHaveLength(2);
    expect(result?.patch).not.toHaveProperty("factsPolicy");
  });

  it("does not accept empty or tiny snippets", () => {
    expect(analyzeStyleSamples("коротко")).toBeNull();
  });
});
