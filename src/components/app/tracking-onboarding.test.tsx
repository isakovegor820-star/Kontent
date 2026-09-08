// @vitest-environment jsdom
import React from "react";
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackingSettingsSection, type ProjectTrackingSettings } from "./tracking-settings-section";
import { trackingDeveloperInstructions } from "./tracking-connection-guide";

configure({ asyncUtilTimeout: 5000 });

const project = vi.hoisted(() => ({ current: { id: 7, role: "owner" }, ready: true, switching: false }));
vi.mock("@/components/app/project-provider", () => ({ useProjects: () => project }));
const empty: ProjectTrackingSettings = {
  status: "not_connected", siteOrigin: null, publicKey: null, attributionWindowDays: 30,
  version: 0, verifiedAt: null, lastPingAt: null, signalReceivedAt: null,
  verificationCheckedAt: null, verificationErrorCode: null,
  verificationFilePath: "/.well-known/aurora-tracker-verification.txt", verificationFileContent: null,
};
const connected: ProjectTrackingSettings = {
  ...empty, status: "pending_verification", siteOrigin: "https://example.ru", version: 1,
  publicKey: "tracker_public_key_1234567890",
  verificationFileContent: "aurora-site-verification=abcdefghijklmnopqrstuvwxyzABCDEFG",
};
let settings: ProjectTrackingSettings;
let fetchMock: ReturnType<typeof vi.fn>;
function reply(body: unknown) { return new Response(JSON.stringify(body), { status: 200 }); }
beforeEach(() => {
  vi.stubGlobal("React", React);
  project.current = { id: 7, role: "owner" };
  settings = { ...empty };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/tracking/templates") return reply({ ok: true, templates: [] });
    if (url === "/api/tracking/settings" && init?.method === "PUT") {
      settings = { ...connected, ...JSON.parse(init.body as string), version: 1 };
    }
    if (url === "/api/tracking/settings/verify") {
      settings = { ...settings, status: "active", verifiedAt: "2026-09-08T10:00:00Z", verificationCheckedAt: "2026-09-08T10:00:00Z", version: 2 };
      return reply({ ok: true, tracking: settings, verified: true });
    }
    return reply({ ok: true, tracking: settings });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("tracking setup journey", () => {
  it("explains all steps before saving and generates an exact downloadable challenge after save", async () => {
    render(<TrackingSettingsSection />);
    await screen.findByRole("button", { name: "Сохранить и получить код" });
    expect(screen.getByRole("list", { name: "Шаги подключения сайта" }).children).toHaveLength(3);
    expect(screen.queryByRole("link", { name: "Скачать проверочный файл" })).toBeNull();
    fireEvent.change(screen.getByLabelText(/Адрес сайта/), { target: { value: "https://example.ru" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить и получить код" }));
    await screen.findByRole("button", { name: "Проверить подключение" });
    fireEvent.click(screen.getByText("Запасной способ: проверочный файл"));
    const download = await screen.findByRole("link", { name: "Скачать проверочный файл" });
    expect(download.getAttribute("download")).toBe("aurora-tracker-verification.txt");
    expect(decodeURIComponent(download.getAttribute("href")!.split(",")[1])).toBe(connected.verificationFileContent);
    expect(screen.getByRole("link", { name: /example.ru\/\.well-known/ }).getAttribute("href")).toBe(`https://example.ru${empty.verificationFilePath}`);
    expect(fetchMock).toHaveBeenCalledWith("/api/tracking/settings", expect.objectContaining({ method: "PUT", body: expect.stringContaining('"expectedVersion":0') }));
  });

  it("uses server verification and keeps installation status separate", async () => {
    settings = { ...connected };
    render(<TrackingSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить подключение" }));
    await screen.findByText("Подключение сохранено");
    expect(screen.queryByRole("button", { name: "Проверить подключение" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/tracking/settings/verify", expect.objectContaining({ method: "POST", body: '{"expectedVersion":1,"verificationMethod":"script"}' }));
    const install = within(screen.getByRole("region", { name: "Состояние счётчика" }));
    expect(install.getByText("Сигналов пока нет")).toBeTruthy();
    settings = { ...settings, signalReceivedAt: "2026-09-08T10:01:00Z" };
    fireEvent.click(screen.getByRole("button", { name: "Обновить статус" }));
    await waitFor(() => expect(install.getByText("Сигнал получен")).toBeTruthy());
    expect(screen.getByText(/Это подтверждает загрузку кода, но не отправку заявки/)).toBeTruthy();
  });

  it("shows persisted verification failures and prevents verification of unsaved changes", async () => {
    settings = { ...connected, status: "verification_failed", verificationErrorCode: "verification_file_missing", verificationCheckedAt: "2026-09-08T10:00:00Z" };
    render(<TrackingSettingsSection />);
    await screen.findByText(/Файл не найден \(404\)/);
    fireEvent.change(screen.getByLabelText(/Адрес сайта/), { target: { value: "https://new.example.ru" } });
    expect((screen.getByRole("button", { name: "Проверить подключение" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Инструкция ниже относится к https:\/\/example.ru/)).toBeTruthy();
  });

  it("allows members to read instructions and check signals but not verify domain", async () => {
    settings = { ...connected };
    project.current = { id: 7, role: "editor" };
    render(<TrackingSettingsSection />);
    await screen.findByText("Запасной способ: проверочный файл");
    fireEvent.click(screen.getByText("Запасной способ: проверочный файл"));
    expect(screen.queryByRole("button", { name: "Проверить подключение" })).toBeNull();
    expect(screen.getByRole("button", { name: "Обновить статус" })).toBeTruthy();
  });

  it("reports clipboard failures without claiming the copy succeeded", async () => {
    settings = { ...connected };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<TrackingSettingsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Скопировать код подключения" }));
    await screen.findByText("Не удалось скопировать. Выдели текст выше и скопируй вручную.");
    expect(screen.queryByText("Скопировано")).toBeNull();
  });

  it("does not keep another project's download after switching projects", async () => {
    settings = { ...connected };
    const { rerender } = render(<TrackingSettingsSection />);
    await screen.findByText("Запасной способ: проверочный файл");
    fireEvent.click(screen.getByText("Запасной способ: проверочный файл"));
    project.current = { id: 9, role: "owner" };
    settings = { ...empty };
    rerender(<TrackingSettingsSection />);
    expect(screen.queryByRole("link", { name: "Скачать проверочный файл" })).toBeNull();
    await screen.findByRole("button", { name: "Сохранить и получить код" });
  });

  it("reopens an active project with saved status and no new verification request", async () => {
    settings = { ...connected, status: "active", verifiedAt: "2026-09-08T10:00:00Z", verificationCheckedAt: "2026-09-08T10:00:00Z", signalReceivedAt: "2026-09-08T10:00:00Z" };
    render(<TrackingSettingsSection />);
    await screen.findByText("Подключение сохранено");
    expect(screen.getByText("Код подключения и повторная проверка").closest("details")?.open).toBe(false);
    expect(screen.getByText("Изменить адрес и срок атрибуции").closest("details")?.open).toBe(false);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("refreshes the browser signal on return without running domain verification", async () => {
    settings = { ...connected };
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const listen = vi.spyOn(window, "addEventListener");
    render(<TrackingSettingsSection />);
    await screen.findByText("Сигналов пока нет");
    await waitFor(() => expect(listen).toHaveBeenCalledWith("focus", expect.any(Function)));
    settings = { ...settings, signalReceivedAt: "2026-09-08T10:01:00Z" };
    fireEvent.focus(window);
    await screen.findByText("Сигнал получен");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/tracking/settings/verify")).toBe(false);
    expect(screen.getByRole("button", { name: "Проверить подключение" })).toBeTruthy();
  });

  it("exports project-specific instructions with attribution and successful-submission requirements", () => {
    const text = trackingDeveloperInstructions(connected, '<script src="https://aurora.example/api/tracking/client.js"></script>');
    expect(text).toContain(`https://example.ru${empty.verificationFilePath}`);
    expect(text).toContain(connected.verificationFileContent);
    expect(text).toContain("После успешного");
    expect(text).toContain("no_attribution");
    expect(text).toContain('"form_submit:" + leadId');
    expect(text).not.toContain("form:12345678");
  });
});
