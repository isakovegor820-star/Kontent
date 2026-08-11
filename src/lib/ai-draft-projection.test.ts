import { describe, expect, it } from "vitest";

import { aiDraftPhaseLabel, createAiDraftProjection, projectAiDraftEvent } from "./ai-draft-projection";
import type { AiStreamEvent } from "./ai-stream";

const requestId = "projection-test";

function apply(events: AiStreamEvent[]) {
  const observed: string[] = [];
  let state = createAiDraftProjection();
  for (const event of events) {
    state = projectAiDraftEvent(state, event);
    observed.push(state.visibleText);
  }
  return { state, observed };
}

describe("AI draft projection", () => {
  it("describes private quality work without promising or exposing an intermediate draft", () => {
    expect(aiDraftPhaseLabel("draft")).toBe("Готовлю текст по выбранным настройкам…");
    expect(aiDraftPhaseLabel("editing")).toBe("Проверяю настройки и улучшаю текст…");
    expect(aiDraftPhaseLabel("writing")).toBe("Создаю готовый пост…");
  });

  it("never erases a complete candidate between editorial passes", () => {
    const { state, observed } = apply([
      { type: "phase", phase: "draft", requestId },
      { type: "delta", text: "Первый полный черновик", requestId },
      { type: "phase", phase: "editing", requestId },
      { type: "replace", text: "", pipeline: "editorial", requestId },
      { type: "delta", text: "Улучшенная", requestId },
      { type: "delta", text: " версия", requestId },
      { type: "phase", phase: "editing", requestId },
      { type: "replace", text: "", pipeline: "editorial", requestId },
      { type: "delta", text: "Финальный", requestId },
      { type: "replace", text: "Финальный готовый пост", pipeline: "editorial", requestId },
      { type: "done", pipeline: "editorial", requestId },
    ]);

    expect(observed.slice(2, 9)).not.toContain("");
    expect(observed[3]).toBe("Первый полный черновик");
    expect(observed[6]).toBe("Улучшенная версия");
    expect(state.visibleText).toBe("Финальный готовый пост");
  });

  it("keeps the last complete pass when a later provider pass errors", () => {
    const { state } = apply([
      { type: "phase", phase: "draft", requestId },
      { type: "delta", text: "Сохранённый черновик", requestId },
      { type: "phase", phase: "editing", requestId },
      { type: "replace", text: "", pipeline: "editorial", requestId },
      { type: "delta", text: "Оборванная часть", requestId },
      {
        type: "error",
        requestId,
        error: "provider_timeout",
        engine: "test",
        label: "Test",
        retryable: true,
      },
    ]);

    expect(state.visibleText).toBe("Сохранённый черновик");
    expect(state.buffer).toBe("Оборванная часть");
  });

  it("keeps an existing post visible while a regenerated first pass is partial", () => {
    let state = createAiDraftProjection("Текущий сохранённый пост");
    state = projectAiDraftEvent(state, { type: "phase", phase: "draft", requestId });
    state = projectAiDraftEvent(state, { type: "delta", text: "Новый", requestId });

    expect(state.buffer).toBe("Новый");
    expect(state.visibleText).toBe("Текущий сохранённый пост");
  });
});
