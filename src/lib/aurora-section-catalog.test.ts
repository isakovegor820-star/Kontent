import { describe, expect, it } from "vitest";

import { ADMIN_DIAGNOSTIC_COMPONENT_IDS, defaultDiagnosticComponentIds } from "./admin-system-diagnostics";
import { APP_NAV_GROUPS } from "./app-routes";
import {
  AURORA_SECTION_BY_ID,
  AURORA_SECTION_CATALOG,
  auroraSloFor,
  isAuroraSectionId,
} from "./aurora-section-catalog";

describe("Aurora section operational catalog", () => {
  it("derives exactly the user-visible sections from APP_NAV_GROUPS without aliases", () => {
    expect(AURORA_SECTION_CATALOG.map((section) => section.id)).toEqual(
      APP_NAV_GROUPS.flatMap((group) => group.routeIds),
    );
    expect(AURORA_SECTION_CATALOG).toHaveLength(15);
    expect(AURORA_SECTION_CATALOG.some((section) => section.id === "competitors" as never)).toBe(false);
    expect(AURORA_SECTION_CATALOG.some((section) => section.id === "trends" as never)).toBe(false);
  });

  it("keeps labels and hrefs from APP_ROUTES and exposes strict feature actions", () => {
    expect(AURORA_SECTION_BY_ID.studio).toMatchObject({
      label: "Студия контента",
      href: "/app/studio",
      features: [{ id: "generation", actions: expect.arrayContaining(["requested", "used"]) }],
    });
  });

  it("uses operation-specific SLO instead of one threshold for API and AI", () => {
    expect(auroraSloFor("studio", "api")?.p95Ms).toBe(1_500);
    expect(auroraSloFor("studio", "provider")?.p95Ms).toBe(120_000);
  });

  it("validates section ids fail-closed", () => {
    expect(isAuroraSectionId("siteAnalysis")).toBe(true);
    expect(isAuroraSectionId("arbitrary")).toBe(false);
  });

  it("only references dependencies that the system diagnostics can actually select", () => {
    // Otherwise «Открыть зависимость» from analytics lands on an empty «Система» panel.
    const known = new Set<string>(ADMIN_DIAGNOSTIC_COMPONENT_IDS);
    for (const section of AURORA_SECTION_CATALOG) {
      for (const dependency of section.dependencies) {
        expect(known.has(dependency), `${section.id} → ${dependency}`).toBe(true);
      }
    }
    expect(defaultDiagnosticComponentIds()).toEqual([...ADMIN_DIAGNOSTIC_COMPONENT_IDS]);
  });
});
