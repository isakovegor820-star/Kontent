// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminCommandPalette, adminSearchHitHref } from "./admin-command-palette";
import { adminFetchMock } from "./__fixtures__/admin-payloads";

describe("AdminCommandPalette", () => {
  const fetchMock = vi.fn();
  const assign = vi.fn();

  beforeEach(() => {
    fetchMock.mockImplementation(adminFetchMock({
      "/api/admin/search": (params) => ({
        query: params.get("q"),
        users: [{ kind: "user", id: 101, title: "Игорь Кузнецов", subtitle: "igor@example.com · 2 проектов", badge: null }],
        projects: [{ kind: "project", id: 12, title: "FitLab", subtitle: "3 участников · 2 каналов", badge: null }],
        posts: [],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("opens with Ctrl+K, searches after two characters and navigates with the keyboard", async () => {
    render(<AdminCommandPalette />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByLabelText("Строка поиска");
    fireEvent.change(input, { target: { value: "и" } });
    expect(screen.getByText(/Введите минимум два символа/u)).toBeTruthy();
    fireEvent.change(input, { target: { value: "иг" } });
    expect(await screen.findByText("Игорь Кузнецов")).toBeTruthy();
    expect(screen.getByText("FitLab")).toBeTruthy();
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("/api/admin/search?q=%D0%B8%D0%B3"));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(assign).toHaveBeenCalledWith("/admin?prid=12#projects");
  });

  it("maps every hit kind to its admin screen", () => {
    expect(adminSearchHitHref({ kind: "user", id: 5, title: "", subtitle: "", badge: null })).toBe("/admin?user=5#users");
    expect(adminSearchHitHref({ kind: "project", id: 5, title: "", subtitle: "", badge: null })).toBe("/admin?prid=5#projects");
    expect(adminSearchHitHref({ kind: "post", id: 5, title: "", subtitle: "", badge: null })).toBe("/admin?pq=5&pstatus=all#publications");
  });
});
