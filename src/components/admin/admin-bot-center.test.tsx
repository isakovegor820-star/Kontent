// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminBotCenter } from "./admin-bot-center";
import { adminFetchMock, botPayload } from "./__fixtures__/admin-payloads";

describe("AdminBotCenter", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    window.history.replaceState({}, "", "/admin#bot-control");
    fetchMock.mockImplementation(adminFetchMock({ "/api/admin/bot": () => botPayload() }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the live runtime banner, six headline metrics and the state tab by default", async () => {
    render(<AdminBotCenter period={7} />);
    expect(await screen.findByText("Аврора")).toBeTruthy();
    expect(screen.getByText("Бот работает: команды и публикации доступны")).toBeTruthy();
    expect(screen.getByText("Business mode не включён")).toBeTruthy();
    for (const label of ["Активны в боте", "Подключили бота", "Черновики из бота", "Ошибки доставки", "Каналы готовы"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("140 команд · 388 кнопок")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Состояние" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Как работают с ботом")).toBeTruthy();
    expect(screen.getByText(/Тексты сообщений, идентификаторы кнопок и токены не сохраняются/u)).toBeTruthy();
    expect(screen.queryByText("Пользователи бота")).toBeNull();
  });

  it("switches tabs through the URL and keeps suspension behind a menu and a confirmation", async () => {
    render(<AdminBotCenter period={7} />);
    await screen.findByText("Аврора");
    fireEvent.click(screen.getByRole("button", { name: "Пользователи" }));
    expect(window.location.search).toBe("?bot=users");
    expect(await screen.findByText("Пользователи бота")).toBeTruthy();
    expect(screen.getByText("Марина Соколова")).toBeTruthy();
    const menu = screen.getAllByLabelText("Ещё действия")[0].closest("details")!;
    expect(menu.hasAttribute("open")).toBe(false);
    expect(screen.queryByRole("button", { name: "Приостановить доступ" })).toBeNull();
    fireEvent.click(screen.getAllByLabelText("Ещё действия")[0]);
    fireEvent.click(screen.getByText("Приостановить доступ к боту"));
    expect(await screen.findByText("Приостановить доступ пользователя к боту?")).toBeTruthy();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("/actions"))).toBe(true);
  });

  it("requests the users page from the server with the search term", async () => {
    render(<AdminBotCenter period={7} />);
    await screen.findByText("Аврора");
    fireEvent.click(screen.getByRole("button", { name: "Пользователи" }));
    await screen.findByText("Пользователи бота");
    const input = screen.getByLabelText("Поиск пользователя бота");
    fireEvent.change(input, { target: { value: "Марина" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => {
      const last = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(last).toContain("usersQuery=%D0%9C%D0%B0%D1%80%D0%B8%D0%BD%D0%B0");
      expect(last).toContain("usersPage=1");
    });
    expect(window.location.search).toContain("botq=");
  });

  it("shows a retryable error instead of a blank screen when the API fails", async () => {
    fetchMock.mockImplementation(adminFetchMock({ "/api/admin/bot": () => ({ status: 503 }) }));
    render(<AdminBotCenter period={7} />);
    expect(await screen.findByText("Не удалось загрузить управление ботом")).toBeTruthy();
    fetchMock.mockImplementation(adminFetchMock({ "/api/admin/bot": () => botPayload() }));
    fireEvent.click(screen.getByRole("button", { name: /Повторить загрузку/u }));
    expect(await screen.findByText("Аврора")).toBeTruthy();
  });
});
