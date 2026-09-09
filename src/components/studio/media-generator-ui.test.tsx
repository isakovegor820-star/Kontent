// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaGenerator } from "./media-generator";

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn<typeof fetch>() }));
vi.mock("@/lib/project-fetch", () => ({ projectFetch: fetcher }));
afterEach(() => { cleanup(); fetcher.mockReset(); vi.unstubAllGlobals(); });
describe("image settings", () => {
  it("sends the displayed format and shows only image creation controls", async () => {
    const fetch = fetcher.mockImplementation(async (url, init) => {
      if (url === "/api/media/capabilities") return Response.json({
        checked: true, configured: true, enabled: true,
        models: [{ kind: "image", id: "nano-banana-2", label: "Nano Banana 2", available: true }],
      });
      if (init?.method === "POST") return Response.json({ error: "worker_unavailable" }, { status: 503 });
      return Response.json({ generations: [] });
    });
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
