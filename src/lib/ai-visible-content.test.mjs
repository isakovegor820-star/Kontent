import { describe, expect, it } from "vitest";

import { createVisibleAiContentFilter, stripAiReasoning } from "./ai-visible-content.mjs";

describe("AI visible-content boundary", () => {
  it("keeps ordinary generated text unchanged", () => {
    const filter = createVisibleAiContentFilter();
    const text = filter.push("Готовый ") + filter.push("пост") + filter.finish();

    expect(text).toBe("Готовый пост");
    expect(filter.hasVisibleContent).toBe(true);
    expect(filter.reasoningDetected).toBe(false);
  });

  it("removes a complete reasoning block and keeps only the answer", () => {
    expect(stripAiReasoning("<think>private reasoning</think>Готовый пост")).toEqual({
      text: "Готовый пост",
      reasoningDetected: true,
    });
  });

  it("recognizes think tags split across streaming chunks", () => {
    const filter = createVisibleAiContentFilter();
    const pieces = ["\n<th", "ink>private", " reasoning</thi", "nk>Готовый ", "пост"];
    const text = pieces.map((piece) => filter.push(piece)).join("") + filter.finish();

    expect(text).toBe("Готовый пост");
    expect(filter.hasVisibleContent).toBe(true);
    expect(filter.reasoningDetected).toBe(true);
  });

  it("never exposes an unfinished reasoning block", () => {
    const filter = createVisibleAiContentFilter();
    const text = filter.push("<think>Here's a thinking process:\n1. private") + filter.finish();

    expect(text).toBe("");
    expect(filter.hasVisibleContent).toBe(false);
    expect(filter.reasoningDetected).toBe(true);
  });

  it("preserves visible text around multiple reasoning blocks", () => {
    expect(stripAiReasoning("Начало<think>one</think> и конец<think>two</think>.").text)
      .toBe("Начало и конец.");
  });
});
