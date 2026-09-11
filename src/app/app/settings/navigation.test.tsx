// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }), useSearchParams: () => new URLSearchParams("section=profile") }));
vi.mock("@/components/app/shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ ready: true, toast: vi.fn(), refreshReal: vi.fn() }) }));
vi.mock("@/components/app/account-profile-settings", () => ({ AccountProfileSettings: () => <div data-settings-dirty="true"><input aria-label="Черновик" defaultValue="Не терять" /></div> }));
import SettingsPage from "./page";

afterEach(() => { cleanup(); replace.mockClear(); });
describe("settings navigation with unsaved changes", () => {
  it("opens an accessible confirmation and preserves the draft when cancelled", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Проект\s*Команда, время и лимиты/ }));
    expect(screen.getByRole("dialog", { name: "Перейти без сохранения?" })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByLabelText("Черновик") as HTMLInputElement).value).toBe("Не терять");
  });
  it("keeps the precise search destination through explicit confirmation", () => {
    render(<SettingsPage />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Найти настройку" }), { target: { value: "шаблоны" } });
    fireEvent.click(screen.getByRole("button", { name: /UTM-шаблоны\s*Интеграции/ }));
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Перейти без сохранения" }));
    expect(replace).toHaveBeenCalledWith("/app/settings?section=integrations&setting=utm", { scroll: false });
  });
});
