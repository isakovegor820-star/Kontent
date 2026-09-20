import { describe, expect, it } from "vitest";
import { APP_NAV_GROUPS } from "./app-routes";
import { currentDiscoverySection, DISCOVERY_ACTIONS, DISCOVERY_SECTIONS, guideHref, searchDiscovery, SECTION_HELP } from "./aurora-discovery";

describe("Aurora navigation discovery", () => {
  it.each([
    ["хочу написать пост", "write-post"],
    ["запланировать публикацию", "schedule-post"],
    ["как подключить канал", "connect-channel"],
    ["КАЛЕНДАРЬ", "calendar"],
    ["картинку", "create-media"],
    ["настройки", "settings"],
  ])("ranks the destination for %s", (query, id) => expect(searchDiscovery(query)[0]?.id).toBe(id));
  it("finds precise settings using the existing setting index", () => {
    expect(searchDiscovery("часовой пояс").some((entry) => entry.href.includes("setting=timezone"))).toBe(true);
  });
  it("covers every navigation section with help and internal destinations", () => {
    expect(DISCOVERY_SECTIONS.map((entry) => entry.id)).toEqual(APP_NAV_GROUPS.flatMap((group) => [...group.routeIds]));
    for (const entry of [...DISCOVERY_SECTIONS, ...DISCOVERY_ACTIONS]) {
      expect(entry.href).toMatch(/^\/app\//);
      expect(SECTION_HELP[entry.sectionId].firstStep.length).toBeGreaterThan(20);
    }
  });
  it("keeps setting and mode destinations when opening a guide", () => {
    const channels = DISCOVERY_ACTIONS.find((entry) => entry.id === "connect-channel")!;
    expect(guideHref(channels)).toBe("/app/settings?section=channels&setting=channels&guide=settings");
  });
  it("resolves nested and aliased routes without matching unrelated paths", () => {
    expect(currentDiscoverySection("/app/studio/questions")).toBe("studio");
    expect(currentDiscoverySection("/app/trends")).toBe("recon");
    expect(currentDiscoverySection("/app/autopilot/month")).toBe("autopilot");
    expect(currentDiscoverySection("/app/studiobad")).toBeUndefined();
  });
  it("offers starting points for an empty query and no invented results for an unknown query", () => {
    expect(searchDiscovery(" ").length).toBeGreaterThan(16);
    expect(searchDiscovery("фывапролджэ")).toEqual([]);
    expect(searchDiscovery("как мне")).toEqual([]);
  });
});
