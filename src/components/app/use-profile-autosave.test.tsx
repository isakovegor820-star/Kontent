// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountProfile } from "@/lib/account-settings";
import { useProfileAutosave } from "./use-profile-autosave";

const fetchMock = vi.hoisted(() => vi.fn());

const refresh = vi.fn(async () => undefined);
const profile: AccountProfile = { firstName: "Анна", lastName: "", displayName: "Анна", jobTitle: "", bio: "", avatar: "", email: "qa@example.test", phone: "+12345678901", locale: "ru", timezone: "UTC", theme: "dark" };
const accepted = (patch: object) => new Response(JSON.stringify({ ok: true, patch, savedAt: new Date().toISOString() }));
function setup() {
  const hook = renderHook(() => useProfileAutosave(refresh));
  act(() => hook.result.current.initialize(profile));
  return hook;
}
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); vi.useFakeTimers(); fetchMock.mockReset(); refresh.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("profile autosave", () => {
  it("debounces typing and sends only changed fields", async () => {
    fetchMock.mockImplementation(async (_url, request) => accepted(JSON.parse(request.body)));
    const { result } = setup();
    act(() => { result.current.update("firstName", "А"); result.current.update("firstName", "Алексей"); });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ firstName: "Алексей" });
    expect(result.current.dirty).toBe(false);
    expect(result.current.draft?.phone).toBe(profile.phone);
  });
  it("serializes saves and retains edits made while a response is pending", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    fetchMock.mockImplementation(async (_url, request) => accepted(JSON.parse(request.body)));
    const { result } = setup();
    act(() => result.current.update("avatar", "/first.webp"));
    act(() => result.current.update("avatar", "/second.webp"));
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => { finish(accepted({ avatar: "/first.webp" })); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.draft?.avatar).toBe("/second.webp");
    expect(result.current.saved?.avatar).toBe("/second.webp");
    expect(result.current.dirty).toBe(false);
  });
  it("keeps failed edits for explicit retry and never claims they were saved", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const { result } = setup();
    await act(async () => result.current.update("avatar", "/new.webp"));
    expect(result.current.error).toContain("Не удалось сохранить");
    expect(result.current.saved?.avatar).toBe("");
    expect(result.current.dirty).toBe(true);
    fetchMock.mockImplementation(async (_url, request) => accepted(JSON.parse(request.body)));
    await act(async () => result.current.flush());
    expect(result.current.error).toBe("");
    expect(result.current.dirty).toBe(false);
  });
  it("does not send an empty display name, and finishes queued writes on navigation", async () => {
    fetchMock.mockImplementation(async (_url, request) => accepted(JSON.parse(request.body)));
    const { result, unmount } = setup();
    act(() => result.current.update("displayName", ""));
    await act(async () => vi.advanceTimersByTimeAsync(700));
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => result.current.update("bio", "Описание"));
    await act(async () => unmount());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ bio: "Описание" });
  });
});
