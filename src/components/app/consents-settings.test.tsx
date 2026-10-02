// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsentsSettings } from "./consents-settings";

const consentState = [
  {
    kind: "pd_processing",
    granted: true,
    changedAt: "2026-10-02T18:00:00.000Z",
    consentTextVersion: "draft-2026-10",
    policyVersion: "2026-08-24",
    source: "register",
  },
  { kind: "marketing", granted: false, changedAt: "", consentTextVersion: null, policyVersion: null, source: null },
  { kind: "pd_distribution", granted: false, changedAt: "", consentTextVersion: null, policyVersion: null, source: null },
  { kind: "cookie", granted: true, changedAt: "2026-10-02T18:05:00.000Z", consentTextVersion: "draft-2026-10", policyVersion: null, source: "cabinet" },
];

const history = [
  {
    kind: "pd_processing",
    granted: true,
    at: "2026-10-02T18:00:00.000Z",
    source: "register",
    consentTextVersion: "draft-2026-10",
    policyVersion: "2026-08-24",
  },
];

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

describe("consents settings section", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ ok: true, revoked: true, current: consentState });
      }
      return jsonResponse({ ok: true, required: false, current: consentState, history });
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows every consent kind, including the ones without consent", async () => {
    render(<ConsentsSettings />);

    // Названия видов встречаются и в списке, и в истории — берём все вхождения.
    expect((await screen.findAllByText("Обработка персональных данных")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Сообщения и рассылки").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Распространение данных в публичном разделе").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Аналитические cookie").length).toBeGreaterThan(0);
    // Статус виден словами, а не только цветом.
    expect(screen.getAllByText("Согласие действует").length).toBe(2);
    expect(screen.getAllByText("Согласия нет").length).toBe(2);
  });

  it("shows when and on which text the consent was given", async () => {
    render(<ConsentsSettings />);
    const lines = await screen.findAllByText(/текст draft-2026-10/);
    const granted = lines.map((node) => node.textContent ?? "").join(" | ");
    expect(granted).toContain("политика 2026-08-24");
    expect(granted).toContain("форма регистрации");
  });

  it("links to the consent text and the policy", async () => {
    render(<ConsentsSettings />);
    await screen.findAllByText("Обработка персональных данных");
    const hrefs = screen.getAllByRole("link").map((node) => node.getAttribute("href"));
    expect(hrefs).toContain("/consent");
    expect(hrefs).toContain("/privacy");
  });

  it("revokes through a confirmation, sending only the kind", async () => {
    render(<ConsentsSettings />);
    const revoke = await screen.findByRole("button", { name: /Отозвать/ });
    fireEvent.click(revoke);

    // Сначала подтверждение: отзыв согласия не должен срабатывать от одного клика.
    expect(await screen.findByText("Отозвать согласие?")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Отозвать согласие" }));
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST");
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({ kind: "pd_processing" });
    });
  });

  it("does not offer revoking cookies from here", async () => {
    render(<ConsentsSettings />);
    await screen.findAllByText("Аналитические cookie");
    // Cookie-согласием управляет баннер: там же хранится выбор по категориям.
    expect(screen.getByText(/Настройки cookie/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Отозвать/ })).toHaveLength(1);
  });

  it("explains the failure instead of pretending the consent was revoked", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ ok: false, error: "server" }, 500);
      return jsonResponse({ ok: true, current: consentState, history });
    });
    render(<ConsentsSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /Отозвать/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Отозвать согласие" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
