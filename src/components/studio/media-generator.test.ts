import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAutomaticVisualBrief,
  mediaGenerationErrorText,
  MediaGenerator,
  startActiveMediaPolling,
} from "./media-generator";

describe("MediaGenerator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a stable polite status region and explicitly labelled prompt controls", () => {
    const html = renderToStaticMarkup(createElement(MediaGenerator, {
      channelId: 18,
      sourceText: "Текущая публикация",
      onUse: vi.fn(),
    }));

    expect(html).toContain('role="status"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain('for="media-prompt"');
    expect(html).toContain("Что создаём?");
    expect(html).toContain("Обложка к посту");
    expect(html).toContain("Напиши, какое изображение нужно создать");
    expect(html).toContain("Взять последний пост");
    expect(html).toContain("Изображение");
    expect(html).not.toContain("Видео");
    expect(html).not.toContain("скоро");
    expect(html).not.toContain("Flux");
  });

  it("builds an editable visual brief automatically and bounds the post context", () => {
    expect(buildAutomaticVisualBrief("  Главная мысль поста  ", "image"))
      .toBe("Визуал без надписей к публикации. Передай её главный смысл через одну ясную сцену: Главная мысль поста");
    expect(buildAutomaticVisualBrief("Сюжет", "video")).toContain("одно ясное действие: Сюжет");
    expect(buildAutomaticVisualBrief("x".repeat(2_000), "image").length).toBeLessThan(1_400);
    expect(buildAutomaticVisualBrief("   ", "image")).toBe("");
  });

  it("не показывает пользователю английские коды ошибок", () => {
    expect(mediaGenerationErrorText("unsafe_media_url")).toContain("безопасно сохранить");
    expect(mediaGenerationErrorText("UNKNOWN_PROVIDER_FAILURE")).toBe("Не удалось создать файл. Измени описание и попробуй ещё раз.");
    expect(mediaGenerationErrorText("Сервис перегружен")).toBe("Сервис перегружен");
  });

  it("polls two active generations serially and does not let one terminal result stop the other", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const poll = vi.fn(async ({ id }: { id: string }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(id);
      await Promise.resolve();
      inFlight -= 1;
      return id === "finished-image" ? { status: "ready" } : { status: "generating" };
    });

    const stop = startActiveMediaPolling([
      { id: "finished-image", kind: "image" },
      { id: "running-video", kind: "video" },
    ], poll, {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["finished-image", "running-video"]);
    expect(maxInFlight).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toEqual([
      "finished-image",
      "running-video",
      "finished-image",
      "running-video",
    ]);
    expect(maxInFlight).toBe(1);

    stop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it("does not overlap polling cycles and stops the remaining snapshot during cleanup", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const poll = vi.fn(async ({ id }: { id: string }) => {
      if (id === "slow-image") await firstRequest;
    });

    const stop = startActiveMediaPolling([
      { id: "slow-image", kind: "image" },
      { id: "waiting-video", kind: "video" },
    ], poll, {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });

    expect(poll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poll).toHaveBeenCalledOnce();

    stop();
    releaseFirst();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(poll).toHaveBeenCalledOnce();
  });
});
