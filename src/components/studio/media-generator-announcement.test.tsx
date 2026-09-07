// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MediaGenerator, type MediaGeneration } from "./media-generator";

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn<typeof fetch>() }));
vi.mock("@/lib/project-fetch", () => ({ projectFetch: fetcher }));
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); fetcher.mockReset();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

it.each([false, true])("announces progress once and respects reduced motion=%s through completion", async reduced => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced })));
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  const generation: MediaGeneration = {
    id: "owned-image", requestId: "owned-request", kind: "image", status: "generating",
    prompt: "Нарисуй зимний лес", model: "nano-banana-2", aspectRatio: "1:1", quality: "medium",
    seconds: null, style: "natural", assetId: null, assetUrl: null, downloadUrl: null,
    mimeType: null, bytes: null, errorCode: null, errorMessage: null,
    createdAt: "2026-09-07T00:00:00Z", updatedAt: "2026-09-07T00:00:00Z", completedAt: null,
  };
  let complete!: (response: Response) => void;
  fetcher.mockImplementation(async input => {
    if (input === "/api/media/generations") return Response.json({ generations: [generation] });
    if (input === "/api/media/capabilities") return Response.json({
      configured: true, enabled: true, checked: true, plan: "fixture",
      models: [{ kind: "image", id: "nano-banana-2", label: "Fixture", available: true }],
    });
    if (input === "/api/media/generations/owned-image") return new Promise(resolve => { complete = resolve; });
    throw new Error(`Unexpected fixture request ${input}`);
  });
  const view = render(<MediaGenerator channelId={18} onUse={vi.fn()} />);
  await waitFor(() => expect(view.container.querySelector('article[aria-label="Запрос: Нарисуй зимний лес"]')).not.toBeNull());
  const announcement = view.container.querySelector('[role="status"].sr-only')!;
  expect(announcement.textContent).toBe("Создаю изображение…");
  expect(announcement.closest('[aria-busy="true"]')).toBeNull();
  expect(view.getAllByRole("status")).toEqual([announcement]);
  expect(view.container.querySelector('article')?.closest('[aria-busy="true"]')).not.toBeNull();
  expect(scroll).toHaveBeenCalledWith({ behavior: reduced ? "instant" : "smooth", block: "nearest" });

  await waitFor(() => expect(complete).toBeTypeOf("function"));
  await act(async () => { complete(Response.json({ generation: { ...generation, status: "ready" } })); });
  expect(view.getByRole("status")).toBe(announcement);
  expect(announcement.textContent).toContain("Готово");
  expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
});
