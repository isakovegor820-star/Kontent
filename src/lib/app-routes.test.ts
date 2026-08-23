import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  APP_ACTIONS,
  APP_BOTTOM_NAV_ROUTE_IDS,
  APP_NAV_GROUPS,
  APP_ROUTES,
  appDraftActionHref,
  composerReturnTarget,
  composerSource,
  composerHydrationIdentity,
  isAppRouteActive,
} from "./app-routes";

describe("app route registry", () => {
  it("keeps sidebar and mobile navigation on the same route definitions", () => {
    const sidebarIds = APP_NAV_GROUPS.flatMap((group) => group.routeIds);

    for (const routeId of APP_BOTTOM_NAV_ROUTE_IDS) {
      expect(sidebarIds).toContain(routeId);
      expect(APP_ROUTES[routeId].href).toMatch(/^\/app(?:\/|$)/u);
    }
  });

  it("keeps Today permanently discoverable in desktop and mobile navigation", () => {
    const workGroup = APP_NAV_GROUPS.find((group) => group.id === "work");
    const shell = readFileSync(new URL("../components/app/shell.tsx", import.meta.url), "utf8");

    expect(workGroup?.routeIds[0]).toBe("today");
    expect(APP_BOTTOM_NAV_ROUTE_IDS).toContain("today");
    expect(shell).not.toContain("useTodayNavigationAvailability");
    expect(shell).not.toContain("summary=availability");
    expect(shell).not.toContain('routeId !== "today"');
  });

  it("puts Growth in results and keeps it off the four-item mobile bar", () => {
    expect(APP_NAV_GROUPS.find((group) => group.id === "results")?.routeIds).toEqual([
      "growth",
      "analytics",
      "settings",
    ]);
    expect(APP_ROUTES.growth).toMatchObject({ href: "/app/growth", label: "Развитие" });
    expect(APP_BOTTOM_NAV_ROUTE_IDS).toHaveLength(4);
    expect(APP_BOTTOM_NAV_ROUTE_IDS).not.toContain("growth");
  });

  it("uses the same aliases for desktop and mobile active state", () => {
    expect(isAppRouteActive("/app/composer", "calendar")).toBe(true);
    expect(isAppRouteActive("/app/competitors/41", "recon")).toBe(true);
    expect(isAppRouteActive("/app/trends", "recon")).toBe(true);
    expect(isAppRouteActive("/app/radar", "recon")).toBe(true);
    expect(isAppRouteActive("/app/recon", "recon")).toBe(true);
    expect(isAppRouteActive("/app/opportunities", "recon")).toBe(true);
    expect(isAppRouteActive("/app/reconnaissance", "recon")).toBe(false);
    expect(APP_ROUTES.recon.href).toBe("/app/competitors");
    expect(APP_ROUTES.recon.activeAliases).toEqual(["/app/trends", "/app/radar", "/app/recon", "/app/opportunities"]);
    const shell = readFileSync(new URL("../components/app/shell.tsx", import.meta.url), "utf8");
    expect(shell).not.toContain('{ href: "/app/recon", label: "Поиск" }');
    expect(shell).toContain('{ href: "/app/competitors", label: "Конкуренты" }');
    expect(shell).toContain('{ href: "/app/trends", label: "Тренды" }');
    expect(shell).toContain('{ href: "/app/opportunities", label: "Карта возможностей", preserveParams: ["channel"] }');
    expect(isAppRouteActive("/app/site-analysis/41", "siteAnalysis")).toBe(true);
  });
});

describe("app action registry", () => {
  it("splits editor/create, discuss, and original destinations exactly", () => {
    expect(APP_ACTIONS.editor).toMatchObject({ destination: "composer", routeId: "composer" });
    expect(APP_ACTIONS.create).toMatchObject({ destination: "studio", routeId: "studio", intent: "create" });
    expect(APP_ACTIONS.discuss).toMatchObject({ destination: "studio", routeId: "studio", intent: "discuss" });
    expect(APP_ACTIONS.original).toEqual({ destination: "external", routeId: null });
  });

  it("puts only the opaque server draft id in internal action URLs", () => {
    const sensitive = "Большой референс с фактами и приватным промптом";

    for (const action of ["editor", "create", "discuss"] as const) {
      const href = appDraftActionHref(action, 41);
      const url = new URL(href, "https://aurora.test");
      expect(url.searchParams.get("draft")).toBe("41");
      expect([...url.searchParams.keys()].sort()).toEqual(
        action === "editor" ? ["draft"] : ["draft", "intent"],
      );
      if (action !== "editor") expect(url.searchParams.get("intent")).toBe(action);
      expect(href).not.toContain(encodeURIComponent(sensitive));
      expect(href).not.toContain("text=");
      expect(href).not.toContain("prompt=");
      expect(href).not.toContain("reference=");
    }
  });

  it("keys Composer hydration by both draft and channel without retaining query text", () => {
    const base = {
      userId: 7,
      draftId: 41,
      legacyId: null,
      channelId: 11,
      date: null,
      time: null,
      fromMedia: false,
    };

    const identity = composerHydrationIdentity(base);
    expect(identity).toContain("draft:41");
    expect(identity).toContain("channel:11");
    expect(composerHydrationIdentity({ ...base, draftId: 42 })).not.toBe(identity);
    expect(composerHydrationIdentity({ ...base, channelId: 12 })).not.toBe(identity);
    expect(composerHydrationIdentity({ ...base, projectId: 8 })).not.toBe(identity);
  });

  it("keeps every Composer entry point paired with a safe return destination", () => {
    expect(composerReturnTarget(composerSource("studio"))).toEqual({
      href: "/app/studio",
      label: "Вернуться в Студию",
    });
    expect(composerReturnTarget(composerSource("autopilot-month"))).toEqual({
      href: "/app/autopilot/month",
      label: "Вернуться к плану месяца",
    });
    expect(composerReturnTarget(composerSource("autopilot"))).toEqual({
      href: "/app/autopilot",
      label: "Вернуться в Автопилот",
    });
    expect(composerReturnTarget(composerSource("studio-visuals"), 41)).toEqual({
      href: "/app/studio/visuals?draft=41",
      label: "Вернуться к визуалам",
    });
    expect(composerReturnTarget(composerSource("unknown"))).toEqual({
      href: "/app/calendar",
      label: "Вернуться в календарь",
    });
  });
});
