import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  APP_ACTIONS,
  APP_BOTTOM_NAV_ROUTE_IDS,
  APP_NAV_GROUPS,
  APP_ROUTES,
  appDraftActionHref,
  composerHydrationIdentity,
  isAppRouteActive,
} from "@/lib/app-routes";
import {
  LibraryCardText,
  handleLibraryCardTextToggle,
  libraryCardContentId,
  toggleExpandedCardId,
} from "@/components/app/library-card-text";
import {
  filterAndSortLibraryItems,
  parseLibraryFilters,
  type LibraryRegistryItem,
} from "@/lib/library-filters";
import {
  LIBRARY_EXPORT_FORMATS,
  renderLibraryExport,
  type LibraryExportSnapshot,
} from "@/lib/library-export.mjs";
import { buildLibraryDraftContext } from "@/lib/library";
import { parseProfileUpdate } from "@/lib/profile";

const libraryPageUrl = new URL("../app/app/library/page.tsx", import.meta.url);
const registryViewUrl = new URL("../components/app/library-registry-view.tsx", import.meta.url);
const profileViewUrl = new URL("../components/app/profile-brief-section.tsx", import.meta.url);
const profileRouteUrl = new URL("../app/api/settings/profile/route.ts", import.meta.url);

function registryItem(overrides: Partial<LibraryRegistryItem> = {}): LibraryRegistryItem {
  return {
    id: "reference:101",
    kind: "reference",
    channelId: 18,
    channelTitle: "Право и технологии",
    sourceId: "42",
    sourceTitle: "Открытый юридический источник",
    sourceUrl: "https://t.me/legal_public/101",
    sourceData: "public_telegram",
    text: "Договор: проверяем обязательные условия до подписания.",
    postedAt: "2026-08-01T10:00:00.000Z",
    format: "photo",
    saved: true,
    viewedAt: null,
    userRating: 5,
    views: 8_000,
    reactions: 120,
    lift: 6.25,
    erBayes: 0.017,
    velocity: 210,
    velocityZ: 2.4,
    freshness: 0.92,
    analyticsScore: 91.4,
    formulaVersion: "aurora-library-v1",
    dataQuality: "high",
    dataMaturity: "mature",
    isHit: true,
    explanation: "Сопоставимая когорта источника, формата и периода.",
    ...overrides,
  };
}

describe("P0 desktop/mobile navigation and Library action contract", () => {
  it("uses one active-route registry on desktop and mobile, including aliases", () => {
    const desktopRouteIds = APP_NAV_GROUPS.flatMap((group) => group.routeIds);
    expect(new Set(desktopRouteIds).size).toBe(desktopRouteIds.length);

    for (const routeId of APP_BOTTOM_NAV_ROUTE_IDS) {
      expect(desktopRouteIds).toContain(routeId);
      expect(APP_ROUTES[routeId].href).toMatch(/^\/app\//u);
    }

    const cases = [
      ["/app/calendar", "calendar"],
      ["/app/composer?draft=901", "calendar"],
      ["/app/studio?draft=901", "studio"],
      ["/app/library?channel=18", "library"],
      ["/app/competitors/42?channel=18", "recon"],
      ["/app/trends?channel=18", "recon"],
      ["/app/radar", "recon"],
      ["/app/site-analysis/9", "siteAnalysis"],
    ] as const;
    for (const [url, routeId] of cases) {
      expect(isAppRouteActive(new URL(url, "https://aurora.test").pathname, routeId)).toBe(true);
    }
  });

  it("keeps channel ownership in the server draft and puts only draft id in action URLs", async () => {
    const longReference = `Большой референс ${"с фактурой и деталями ".repeat(400)}`;
    const draft = buildLibraryDraftContext({
      text: longReference,
      channelId: 18,
      clientKey: "draft_library_e2e_1234567890",
      reference: { competitorId: 42, sourceLabel: "Открытый источник" },
    });

    expect(draft).toMatchObject({
      text: longReference,
      origin: "competitor",
      channelIds: [18],
      sourceRef: { kind: "competitor", id: "42", label: "Открытый источник" },
    });
    expect(composerHydrationIdentity({
      userId: 7,
      draftId: 901,
      legacyId: null,
      channelId: draft.channelIds[0],
      date: null,
      time: null,
      fromMedia: false,
    })).toContain("channel:18");

    const editor = new URL(appDraftActionHref("editor", 901), "https://aurora.test");
    const create = new URL(appDraftActionHref("create", 901), "https://aurora.test");
    const discuss = new URL(appDraftActionHref("discuss", 901), "https://aurora.test");
    expect(editor.pathname).toBe("/app/composer");
    expect(create.pathname).toBe("/app/studio");
    expect(discuss.pathname).toBe("/app/studio");
    for (const target of [editor, create, discuss]) {
      expect(target.searchParams.get("draft")).toBe("901");
      expect(target.href).not.toContain(encodeURIComponent(longReference.slice(0, 80)));
      expect(target.searchParams.has("channel")).toBe(false);
      expect(target.searchParams.has("content")).toBe(false);
    }
    expect([...editor.searchParams.keys()]).toEqual(["draft"]);
    expect(create.searchParams.get("intent")).toBe("create");
    expect(discuss.searchParams.get("intent")).toBe("discuss");
    expect(APP_ACTIONS.original).toEqual({ destination: "external", routeId: null });

    // push (not replace) leaves the Library history entry intact for browser Back.
    const actionSources = `${await readFile(libraryPageUrl, "utf8")}\n${await readFile(registryViewUrl, "utf8")}`;
    expect(actionSources.match(/router\.push\(appDraftActionHref/gu)?.length).toBe(2);
    expect(actionSources).not.toMatch(/router\.replace\(appDraftActionHref/gu);
  });

  it("expands cards independently with an announced state and no parent navigation", () => {
    const firstId = libraryCardContentId("registry", "reference:101");
    const secondId = libraryCardContentId("registry", "reference:102");
    const onToggle = vi.fn();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    const closed = renderToStaticMarkup(createElement(LibraryCardText, {
      contentId: firstId,
      text: "Полный текст первой карточки",
      expanded: false,
      onToggle,
    }));
    const opened = renderToStaticMarkup(createElement(LibraryCardText, {
      contentId: secondId,
      text: "Полный текст второй карточки",
      expanded: true,
      onToggle,
    }));
    expect(closed).toContain("line-clamp-4");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain(`aria-controls="${firstId}"`);
    expect(closed).toContain("Развернуть");
    expect(opened).not.toContain("line-clamp-4");
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).toContain(`aria-controls="${secondId}"`);
    expect(opened).toContain("Свернуть");

    const first = toggleExpandedCardId(new Set(), "reference:101");
    const both = toggleExpandedCardId(first, "reference:102");
    expect(first).toEqual(new Set(["reference:101"]));
    expect(both).toEqual(new Set(["reference:101", "reference:102"]));

    handleLibraryCardTextToggle({ preventDefault, stopPropagation }, onToggle);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(stopPropagation.mock.invocationCallOrder[0]).toBeLessThan(onToggle.mock.invocationCallOrder[0]);
  });
});

describe("P1 filtered Library snapshot and exports", () => {
  it("applies the complete registry filter once and renders all six formats from that snapshot", async () => {
    const params = new URLSearchParams([
      ["channel", "18"],
      ["source", "42"],
      ["from", "2026-07-01"],
      ["to", "2026-08-05"],
      ["q", "договор"],
      ["format", "photo"],
      ["saved", "saved"],
      ["viewed", "new"],
      ["ratingMin", "4"],
      ["ratingMax", "5"],
      ["viewsMin", "1000"],
      ["reactionsMin", "10"],
      ["liftMin", "5"],
      ["scoreMin", "80"],
      ["scoreMax", "100"],
      ["quality", "high"],
      ["maturity", "mature"],
      ["sort", "velocity"],
      ["direction", "desc"],
      ["hit", "only"],
    ]);
    const filters = parseLibraryFilters(params);
    const items = [
      registryItem(),
      registryItem({ id: "reference:102", sourceId: "99", sourceTitle: "Другой источник" }),
      registryItem({ id: "reference:103", userRating: 2, analyticsScore: 99 }),
      registryItem({ id: "saved:104", kind: "saved", format: "text", isHit: false }),
    ];
    const filtered = filterAndSortLibraryItems(items, filters);

    expect(filters).toMatchObject({
      channelId: 18,
      sourceIds: ["42"],
      formats: ["photo"],
      saved: "saved",
      viewed: "new",
      ratingMin: 4,
      ratingMax: 5,
      liftMin: 5,
      scoreMin: 80,
      scoreMax: 100,
      qualities: ["high"],
      maturities: ["mature"],
      sort: "velocity",
      hitOnly: true,
    });
    expect(filtered.map((item) => item.id)).toEqual(["reference:101"]);
    expect(filtered[0].userRating).toBe(5);
    expect(filtered[0].analyticsScore).toBe(91.4);

    const snapshot: LibraryExportSnapshot = {
      exportedAt: "2026-08-05T10:00:00.000Z",
      activeFilters: filters as unknown as Record<string, unknown>,
      formulaVersion: "aurora-library-v1",
      items: filtered as unknown as Array<Record<string, unknown>>,
    };
    expect(LIBRARY_EXPORT_FORMATS).toEqual(["csv", "xlsx", "json", "pdf", "html", "markdown"]);

    const rendered = await Promise.all(
      LIBRARY_EXPORT_FORMATS.map(async (format) => [format, await renderLibraryExport(format, snapshot)] as const),
    );
    expect(new Set(rendered.map(([, file]) => file.extension))).toEqual(
      new Set(["csv", "xlsx", "json", "pdf", "html", "md"]),
    );
    expect(rendered.every(([, file]) => file.bytes.length > 100)).toBe(true);
    expect(rendered.find(([format]) => format === "csv")?.[1].bytes.subarray(0, 3)).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
    expect(rendered.find(([format]) => format === "xlsx")?.[1].bytes.subarray(0, 2).toString()).toBe("PK");
    expect(rendered.find(([format]) => format === "pdf")?.[1].bytes.subarray(0, 4).toString()).toBe("%PDF");

    for (const format of ["csv", "xlsx", "json", "html", "markdown"] as const) {
      const file = rendered.find(([candidate]) => candidate === format)?.[1];
      expect(file?.bytes.toString("utf8")).toContain("aurora-library-v1");
    }
    const json = JSON.parse(rendered.find(([format]) => format === "json")![1].bytes.toString("utf8"));
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({
      id: "reference:101",
      userRating: 5,
      analyticsScore: 91.4,
      sourceUrl: "https://t.me/legal_public/101",
      sourceData: "public_telegram",
    });
  });
});

describe("P1 profile reload and unsaved-change contract", () => {
  it("round-trips the editable brief through the existing content_brief authority", async () => {
    const parsed = parseProfileUpdate({
      requestKey: "profile-e2e-save-0001",
      channelId: 18,
      name: "Анна",
      avatar: "https://cdn.example.test/avatar.png",
      brief: {
        niche: "Право для бизнеса",
        audience: "Владельцы небольших компаний",
        goal: "Объяснять изменения",
        rubrics: ["Практика", "Разборы"],
        formats: ["Текст", "Видео"],
        authorRole: "Управляющий партнёр",
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);

    const serializedServerPayload = JSON.stringify({
      ok: true,
      account: { name: parsed.value.name, avatar: parsed.value.avatar, email: "anna@example.test" },
      channelId: parsed.value.channelId,
      brief: { ...parsed.value.brief, ready: true, source: "manual" },
    });
    expect(JSON.parse(serializedServerPayload)).toMatchObject({
      channelId: 18,
      account: { name: "Анна", avatar: "https://cdn.example.test/avatar.png" },
      brief: {
        niche: "Право для бизнеса",
        audience: "Владельцы небольших компаний",
        rubrics: ["Практика", "Разборы"],
        formats: ["Текст", "Видео"],
        authorRole: "Управляющий партнёр",
        ready: true,
        source: "manual",
      },
    });

    const [routeSource, viewSource] = await Promise.all([
      readFile(profileRouteUrl, "utf8"),
      readFile(profileViewUrl, "utf8"),
    ]);
    expect(routeSource).toContain("insert into content_brief");
    expect(routeSource).toContain("on conflict (user_id, channel_id) do update");
    expect(routeSource).not.toMatch(/insert into (?:channel_)?profiles\b/iu);
    expect(viewSource).toContain("fetch(`/api/settings/profile?channel=${channelId}`");
    expect(viewSource).toContain('window.addEventListener("beforeunload", beforeUnload)');
    expect(viewSource).toContain("Есть несохранённые изменения");
    expect(viewSource).toContain("Сохранить профиль");
    expect(viewSource).toContain("Email изменится только после подтверждения");
  });
});
