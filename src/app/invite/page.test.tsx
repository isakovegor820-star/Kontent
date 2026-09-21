// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProjectInvitePage from "./page";
import { AuthScreen } from "@/components/auth/auth-screen";
import { PROJECT_INVITE_STORAGE_KEY } from "@/lib/project-invite-client";

const mocks = vi.hoisted(() => ({
  user: { id: 1, email: "owner@example.test", name: "Owner", onboarded: true } as { id: number; email: string; name: string; onboarded: boolean } | null,
  authError: false,
  refreshAuth: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
  fetch: vi.fn(),
}));
vi.mock("@/lib/store", () => ({ useStore: () => ({ authReady: true, authError: mocks.authError, user: mocks.user, refreshAuth: mocks.refreshAuth }) }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
const token = "d".repeat(43);
function reply(status: number, body: object) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function accept() { fireEvent.click(await screen.findByRole("button", { name: "Принять приглашение" })); }
async function changeHash(value: string) {
  await act(async () => {
    window.history.replaceState(null, "", `/invite#token=${value}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockReset();
  mocks.refreshAuth.mockReset();
  mocks.user = { id: 1, email: "owner@example.test", name: "Owner", onboarded: true };
  mocks.authError = false;
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", mocks.fetch);
  window.sessionStorage.clear();
  window.history.replaceState({ next: "preserved" }, "", `/invite#token=${token}`);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("shows the current account and retains the invitation after a mismatch with an actionable switch button", async () => {
  mocks.fetch.mockResolvedValue(reply(403, { error: "email_mismatch" }));
  render(<ProjectInvitePage />);
  await accept();
  expect((await screen.findByRole("alert")).textContent).toContain("другой почты");
  expect(screen.getByText("owner@example.test")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Принять приглашение" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Войти в другой аккаунт" })).toBeTruthy();
  expect(window.sessionStorage.getItem(PROJECT_INVITE_STORAGE_KEY)).toBe(token);
  expect(window.location.hash).toBe("");
  expect(window.history.state).toEqual({ next: "preserved" });
});

it("waits for successful logout and a confirmed anonymous account before navigating to login", async () => {
  const logout = pending<ReturnType<typeof reply>>();
  const auth = pending<void>();
  mocks.fetch.mockReturnValue(logout.promise);
  mocks.refreshAuth.mockImplementation(async () => { await auth.promise; mocks.user = null; });
  const page = render(<ProjectInvitePage />);
  fireEvent.click(await screen.findByRole("button", { name: "Войти в другой аккаунт" }));
  expect(mocks.router.replace).not.toHaveBeenCalled();
  expect(mocks.refreshAuth).not.toHaveBeenCalled();
  await act(async () => logout.resolve(reply(200, { ok: true })));
  expect(mocks.refreshAuth).toHaveBeenCalledOnce();
  expect(mocks.router.replace).not.toHaveBeenCalled();
  await act(async () => auth.resolve());
  await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith("/login"));
  expect(window.sessionStorage.getItem(PROJECT_INVITE_STORAGE_KEY)).toBe(token);
  expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(mocks.fetch.mock.calls[0][0]).toBe("/api/auth/logout");
  page.unmount();
  mocks.user = { id: 2, email: "recipient@example.test", name: "Recipient", onboarded: false };
  render(<AuthScreen mode="login" />);
  await waitFor(() => expect(mocks.router.replace).toHaveBeenLastCalledWith("/invite"));
});

it("keeps the token and provides a retry when logout fails", async () => {
  mocks.fetch.mockResolvedValue(reply(503, { ok: false }));
  render(<ProjectInvitePage />);
  fireEvent.click(await screen.findByRole("button", { name: "Войти в другой аккаунт" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Не удалось завершить выход");
  expect(mocks.router.replace).not.toHaveBeenCalled();
  expect(mocks.refreshAuth).not.toHaveBeenCalled();
  expect(window.sessionStorage.getItem(PROJECT_INVITE_STORAGE_KEY)).toBe(token);
});

it("recovers an expired session and hands the same invitation to login", async () => {
  mocks.fetch.mockResolvedValue(reply(401, { error: "unauthorized" }));
  mocks.refreshAuth.mockImplementation(async () => { mocks.user = null; });
  render(<ProjectInvitePage />);
  await accept();
  const login = await screen.findByRole("button", { name: "Войти или создать аккаунт" });
  expect(screen.getByRole("alert").textContent).toContain("Сессия завершилась");
  expect(mocks.refreshAuth).toHaveBeenCalledOnce();
  fireEvent.click(login);
  expect(mocks.router.push).toHaveBeenCalledWith("/login");
  expect(window.sessionStorage.getItem(PROJECT_INVITE_STORAGE_KEY)).toBe(token);
});

it("can retry an unavailable auth check after logout without navigating under the old account", async () => {
  mocks.fetch.mockResolvedValue(reply(200, { ok: true }));
  mocks.refreshAuth.mockImplementationOnce(async () => { mocks.authError = true; });
  const page = render(<ProjectInvitePage />);
  fireEvent.click(await screen.findByRole("button", { name: "Войти в другой аккаунт" }));
  await screen.findByRole("button", { name: "Повторить проверку" });
  expect(mocks.router.replace).not.toHaveBeenCalled();
  mocks.authError = false;
  mocks.user = null;
  page.rerender(<ProjectInvitePage />);
  await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith("/login"));
});

it("keeps a valid URL and permits acceptance when browser storage is blocked", async () => {
  vi.spyOn(window, "sessionStorage", "get").mockReturnValue({
    getItem: () => null,
    setItem: () => { throw new DOMException("blocked", "SecurityError"); },
    removeItem: () => {},
  } as unknown as Storage);
  mocks.fetch.mockResolvedValue(reply(200, { ok: true }));
  render(<ProjectInvitePage />);
  await screen.findByRole("button", { name: "Принять приглашение" });
  expect(window.location.hash).toBe(`#token=${token}`);
  expect(screen.getByText(/Браузер не позволяет сохранить/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Войти в другой аккаунт" }));
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.router.replace).not.toHaveBeenCalled();
  await accept();
  await screen.findByText("Приглашение принято");
  expect(window.location.hash).toBe("");
});

it("handles an inaccessible sessionStorage getter on both invite and login", async () => {
  vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
  const page = render(<ProjectInvitePage />);
  await screen.findByRole("button", { name: "Принять приглашение" });
  expect(window.location.hash).toBe(`#token=${token}`);
  page.unmount();
  render(<AuthScreen mode="login" />);
  await waitFor(() => expect(mocks.router.replace).toHaveBeenCalledWith("/app/calendar"));
});

it("does not submit a previous stored invitation for a malformed incoming link", async () => {
  window.sessionStorage.setItem(PROJECT_INVITE_STORAGE_KEY, token);
  window.history.replaceState(null, "", "/invite#token=broken");
  render(<ProjectInvitePage />);
  await screen.findByText(/В ссылке нет действующего приглашения/);
  expect(window.sessionStorage.getItem(PROJECT_INVITE_STORAGE_KEY)).toBeNull();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("accepts a new hash without reload and ignores a late result for the previous invitation", async () => {
  const earlier = pending<ReturnType<typeof reply>>();
  mocks.fetch.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce(reply(200, { ok: true }));
  render(<ProjectInvitePage />);
  await accept();
  const nextToken = "e".repeat(43);
  await changeHash(nextToken);
  await act(async () => earlier.resolve(reply(200, { ok: true })));
  expect(screen.queryByText("Приглашение принято")).toBeNull();
  expect(window.sessionStorage.getItem(PROJECT_INVITE_STORAGE_KEY)).toBe(nextToken);
  await accept();
  await screen.findByText("Приглашение принято");
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).token).toBe(nextToken);
  expect(window.sessionStorage.getItem(PROJECT_INVITE_STORAGE_KEY)).toBeNull();
});

it.each(["invitation_expired", "invitation_revoked", "invitation_used", "invitation_not_found", "invalid_token", "already_member"])("stops retrying a terminal %s and removes the pending login redirect", async (error) => {
  mocks.fetch.mockResolvedValue(reply(410, { error }));
  render(<ProjectInvitePage />);
  await accept();
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Принять приглашение" })).toBeNull();
  expect(screen.getByRole("link", { name: "Перейти к проектам" })).toBeTruthy();
  expect(window.sessionStorage.getItem(PROJECT_INVITE_STORAGE_KEY)).toBeNull();
});

it("does not promise an unused invitation when the response is lost", async () => {
  mocks.fetch.mockRejectedValue(new TypeError("network"));
  render(<ProjectInvitePage />);
  await accept();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Не удалось получить подтверждение");
  expect(alert.textContent).not.toContain("не использовано");
  expect(window.sessionStorage.getItem(PROJECT_INVITE_STORAGE_KEY)).toBe(token);
});

it("allows the new account to accept after an earlier account email mismatch", async () => {
  mocks.fetch.mockResolvedValueOnce(reply(403, { error: "email_mismatch" })).mockResolvedValueOnce(reply(200, { ok: true }));
  const page = render(<ProjectInvitePage />);
  await accept();
  await screen.findByRole("alert");
  mocks.user = { id: 2, email: "recipient@example.test", name: "Recipient", onboarded: true };
  page.rerender(<ProjectInvitePage />);
  await accept();
  await screen.findByText("Приглашение принято");
  fireEvent.click(screen.getByRole("button", { name: "Открыть проект" }));
  expect(mocks.router.push).toHaveBeenCalledWith("/app/calendar");
});
