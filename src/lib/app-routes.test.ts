import { describe, expect, it } from "vitest";

import {
  APP_ACTIONS,
  APP_BOTTOM_NAV_ROUTE_IDS,
  APP_NAV_GROUPS,
  APP_ROUTES,
  appDraftActionHref,
  composerHydrationIdentity,
  getActiveReconTabRouteId,
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

  it("uses the same aliases for desktop and mobile active state", () => {
    expect(isAppRouteActive("/app/composer", "calendar")).toBe(true);
    expect(isAppRouteActive("/app/competitors/41", "recon")).toBe(true);
    expect(isAppRouteActive("/app/trends", "recon")).toBe(true);
    expect(isAppRouteActive("/app/radar", "recon")).toBe(true);
    expect(isAppRouteActive("/app/reconnaissance", "recon")).toBe(false);
    expect(isAppRouteActive("/app/site-analysis/41", "siteAnalysis")).toBe(true);
  });

  it("resolves every reconnaissance alias to one visible tab", () => {
    expect(getActiveReconTabRouteId("/app/recon")).toBe("recon");
    expect(getActiveReconTabRouteId("/app/radar")).toBe("recon");
    expect(getActiveReconTabRouteId("/app/competitors/41")).toBe("competitors");
    expect(getActiveReconTabRouteId("/app/trends")).toBe("trends");
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
  });
});
