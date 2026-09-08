// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_BRIEF } from "@/lib/brief";
import { ChannelSettingsCenter } from "./channel-settings-center";

const mocks = vi.hoisted(() => ({ toast: vi.fn(), fetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/store", () => ({
  useStore: () => ({
    realReady: true,
    realChannels: [
      { id: 22, title: "Первый канал", network: "tg", is_active: true },
      { id: 23, title: "Второй канал", network: "tg", is_active: true },
    ],
    toast: mocks.toast,
  }),
}));

const settings = {
  enabled: true, mode: "confirm", post_frequency: 7, approvals_streak: 0,
  generation_engine: "navy-deepseek-pro", planning_months: 1, planning_weeks: 2,
  quick_settings: { newsPerWeek: 4, detail: 2, energy: 2, emoji: 2 },
};
const brief = { ...EMPTY_BRIEF, niche: "Кофейня", audience: "Жители района", ready: true };
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });
const slider = (name: string) => screen.getByRole("slider", { name }) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: "Сохранить автопилот" }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const saved = JSON.parse(String(init.body));
      delete saved.channelId;
      return reply({ ok: true, settings: { ...settings, ...saved } });
    }
    return reply({ brief, settings: { ...settings, post_frequency: url.endsWith("23") ? 3 : 7 } });
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Autopilot channel settings", () => {
  it("shows every control on entry without an extra edit click", async () => {
    render(<ChannelSettingsCenter view="autopilot" />);
    await screen.findByRole("heading", { name: "Как Аврора планирует" });
    expect(slider("Постов в неделю").value).toBe("7");
    expect(slider("Период одного плана").value).toBe("2");
    expect(slider("Свежих событий в неделю").value).toBe("4");
    expect(slider("Объём постов").value).toBe("2");
    expect(slider("Подача").value).toBe("2");
    expect(slider("Эмодзи").value).toBe("2");
    expect((screen.getByRole("combobox", { name: "Модель для постов" }) as HTMLSelectElement).value).toBe("navy-deepseek-pro");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(saveButton().disabled).toBe(true);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("sends all controls to the selected channel and keeps the saved form open", async () => {
    render(<ChannelSettingsCenter view="autopilot" />);
    await screen.findByRole("heading", { name: "Как Аврора планирует" });
    for (const [name, value] of [
      ["Постов в неделю", "3"], ["Период одного плана", "7"],
      ["Свежих событий в неделю", "1"], ["Объём постов", "3"],
      ["Подача", "1"], ["Эмодзи", "0"],
    ]) fireEvent.input(slider(name), { target: { value } });
    fireEvent.change(screen.getByRole("combobox", { name: "Модель для постов" }), { target: { value: "navy-gpt-5-4" } });
    fireEvent.click(screen.getByRole("switch"));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Автопилот настроен" })));
    const [, init] = mocks.fetch.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(JSON.parse(init.body)).toEqual({
      channelId: 22, enabled: false, mode: "confirm", post_frequency: 3,
      planning_weeks: 7, generation_engine: "navy-gpt-5-4",
      quick_settings: { newsPerWeek: 1, detail: 3, energy: 1, emoji: 0 },
    });
    expect(slider("Постов в неделю").value).toBe("3");
    expect(saveButton().disabled).toBe(true);
  });

  it("opens settings immediately after switching channels or returning from content", async () => {
    const view = render(<ChannelSettingsCenter view="content" />);
    await screen.findByRole("heading", { name: "Как Аврора пишет" });
    view.rerender(<ChannelSettingsCenter view="autopilot" />);
    await screen.findByRole("heading", { name: "Как Аврора планирует" });
    fireEvent.click(screen.getByRole("button", { name: "Второй канал" }));
    await waitFor(() => expect(slider("Постов в неделю").value).toBe("3"));
    fireEvent.input(slider("Эмодзи"), { target: { value: "0" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    const [, init] = mocks.fetch.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(JSON.parse(init.body).channelId).toBe(23);
  });

  it("retains an editable unsaved draft when the server rejects saving", async () => {
    render(<ChannelSettingsCenter view="autopilot" />);
    await screen.findByRole("heading", { name: "Как Аврора планирует" });
    fireEvent.input(slider("Подача"), { target: { value: "3" } });
    mocks.fetch.mockResolvedValueOnce(reply({ ok: false, error: "unavailable" }, false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Автопилот не сохранён" })));
    expect(slider("Подача").value).toBe("3");
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(slider("Подача").value).toBe("2");
    expect(saveButton().disabled).toBe(true);
  });
});
