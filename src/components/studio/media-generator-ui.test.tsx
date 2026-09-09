// @vitest-environment jsdom
import { setProjectTransport } from "@/lib/project-transport";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaGenerator } from "./media-generator";

beforeEach(() => setProjectTransport(7, true, 3));
afterEach(() => { cleanup(); setProjectTransport(null); vi.unstubAllGlobals(); });
describe("image settings", () => {
  it("sends the displayed format and shows only image creation controls", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/media/capabilities") return Response.json({
        checked: true, configured: true, enabled: true,
        models: [{ kind: "image", id: "nano-banana-2", label: "Nano Banana 2", available: true }],
      });
      if (init?.method === "POST") return Response.json({ error: "worker_unavailable" }, { status: 503 });
      return Response.json({ generations: [] }, { headers: { "x-aurora-project-id": "7" } });
    });
    vi.stubGlobal("fetch", fetch);
    render(<MediaGenerator channelId={18} onUse={vi.fn()} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    fireEvent.change(screen.getByLabelText("Формат изображения"), { target: { value: "9:16" } });
    expect(screen.getByText("9:16 · сторис · Для публикации")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Опиши, что нужно создать"), { target: { value: "Портрет девушки у окна" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать изображение" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const request = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ kind: "image", aspectRatio: "9:16", quality: "medium" });
    expect(screen.queryByText(/Видео|Вертикальный рилс/)).toBeNull();
  });
});
