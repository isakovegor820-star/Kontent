// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CookieConsentBanner,
  COOKIE_CONSENT_EVENT,
  COOKIE_CONSENT_OPEN_EVENT,
  persistConsent,
} from "./cookie-consent-banner";
import { COOKIE_CONSENT_NAME, buildConsent, readConsentFromCookieString } from "@/lib/cookie-consent";

function clearCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

describe("cookie consent banner", () => {
  beforeEach(() => {
    clearCookies();
  });

  afterEach(() => {
    cleanup();
    clearCookies();
  });

  it("shows on the first visit and offers accept, refuse and settings", async () => {
    render(<CookieConsentBanner />);
    expect(await screen.findByRole("button", { name: "Принять все" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Только необходимые" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Настроить" })).toBeTruthy();
    // Ссылки на документы обязаны быть в самом баннере, а не только в подвале.
    const links = screen.getAllByRole("link").map((node) => node.getAttribute("href"));
    expect(links).toContain("/cookies");
    expect(links).toContain("/privacy");
  });

  it("does not show the banner when a decision is already stored", async () => {
    persistConsent(buildConsent("necessary"));
    render(<CookieConsentBanner />);
    // Даём эффекту отработать: если бы баннер показывался, кнопка была бы в DOM.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Принять все" })).toBeNull();
  });

  it("stores the all-cookies decision and hides itself", async () => {
    render(<CookieConsentBanner />);
    const events: string[] = [];
    window.addEventListener(COOKIE_CONSENT_EVENT, () => events.push("consent"));
    fireEvent.click(await screen.findByRole("button", { name: "Принять все" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Принять все" })).toBeNull();
    });
    const stored = readConsentFromCookieString(document.cookie);
    expect(stored?.decision).toBe("all");
    expect(stored?.categories.analytics).toBe(true);
    // Событие нужно инициализации аналитики: без него счётчики не стартуют.
    expect(events).toEqual(["consent"]);
    window.removeEventListener(COOKIE_CONSENT_EVENT, () => events.push("consent"));
  });

  it("allows refusing analytics without losing access to the service", async () => {
    render(<CookieConsentBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Только необходимые" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Принять все" })).toBeNull();
    });
    const stored = readConsentFromCookieString(document.cookie);
    expect(stored?.decision).toBe("necessary");
    expect(stored?.categories).toEqual({ necessary: true, analytics: false, marketing: false });
  });

  it("saves a custom choice from the settings step", async () => {
    render(<CookieConsentBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Настроить" }));
    const analytics = document.querySelector<HTMLInputElement>('input[data-cookie-category="analytics"]');
    expect(analytics).toBeTruthy();
    fireEvent.click(analytics as HTMLInputElement);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить выбор" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Сохранить выбор" })).toBeNull();
    });
    const stored = readConsentFromCookieString(document.cookie);
    expect(stored?.decision).toBe("custom");
    expect(stored?.categories.analytics).toBe(true);
    expect(stored?.categories.marketing).toBe(false);
  });

  it("can be reopened from the footer link", async () => {
    persistConsent(buildConsent("necessary"));
    render(<CookieConsentBanner />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Принять все" })).toBeNull();

    act(() => {
      window.dispatchEvent(new Event(COOKIE_CONSENT_OPEN_EVENT));
    });
    expect(await screen.findByRole("button", { name: "Принять все" })).toBeTruthy();
  });

  it("keeps the stored cookie name stable", () => {
    // Имя — часть контракта: его читает инициализация аналитики на клиенте.
    expect(COOKIE_CONSENT_NAME).toBe("aurora_cookie_consent");
  });
});
