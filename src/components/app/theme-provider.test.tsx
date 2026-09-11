// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppThemeProvider, useAppTheme } from "./theme-provider";
import { APP_THEME_COOKIE } from "@/lib/app-theme";

const fetchMock = vi.hoisted(() => vi.fn());

let systemChange: () => void;
let dark = true;
function Controls() {
  const theme = useAppTheme();
  return <><select aria-label="Тема" value={theme.preference} onChange={(event) => theme.setPreference(event.target.value as "light" | "dark" | "system")}><option value="light">Светлая</option><option value="dark">Тёмная</option><option value="system">Как в системе</option></select><p>{theme.error}</p><button onClick={theme.retry}>Повторить</button></>;
}
beforeEach(() => { vi.stubGlobal("fetch", fetchMock);
  dark = true;
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ get matches() { return dark; }, addEventListener: (_event: string, callback: () => void) => { systemChange = callback; }, removeEventListener: vi.fn() })) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("instant account appearance", () => {
  it("applies appearance before the request completes and follows system changes", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { container } = render(<AppThemeProvider initialPreference="dark"><Controls /></AppThemeProvider>);
    fireEvent.change(screen.getByLabelText("Тема"), { target: { value: "light" } });
    expect(container.querySelector(".app-v3")?.getAttribute("data-theme")).toBe("light");
    expect(document.cookie).toContain(`${APP_THEME_COOKIE}=light`);
    fireEvent.change(screen.getByLabelText("Тема"), { target: { value: "system" } });
    expect(container.querySelector(".app-v3")?.getAttribute("data-theme")).toBe("dark");
    act(() => { dark = false; systemChange(); });
    expect(container.querySelector(".app-v3")?.getAttribute("data-theme")).toBe("light");
    await act(async () => finish(new Response(JSON.stringify({ ok: true }))));
    expect(fetchMock.mock.calls.map(([, request]) => JSON.parse(request.body))).toEqual([{ theme: "light" }, { theme: "system" }]);
  });
  it("retains local appearance, explains a failure and retries persistence", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const { container } = render(<AppThemeProvider initialPreference="dark"><Controls /></AppThemeProvider>);
    await act(async () => fireEvent.change(screen.getByLabelText("Тема"), { target: { value: "light" } }));
    expect(container.querySelector(".app-v3")?.getAttribute("data-theme")).toBe("light");
    expect(screen.getByText(/не сохранена в аккаунте/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByText("Повторить")));
    expect(screen.queryByText(/не сохранена в аккаунте/)).toBeNull();
  });
});
