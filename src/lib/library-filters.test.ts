import { describe, expect, it } from "vitest";
import {
  filterAndSortLibraryItems,
  parseLibraryFilters,
  type LibraryRegistryItem,
} from "./library-filters";

function item(overrides: Partial<LibraryRegistryItem>): LibraryRegistryItem {
  return {
    id: "reference:1",
    kind: "reference",
    channelId: 1,
    channelTitle: "Канал",
    sourceId: "10",
    sourceTitle: "Источник",
    sourceUrl: "https://example.test/1",
    sourceData: "public_telegram",
    text: "Текст",
    postedAt: "2026-08-01T10:00:00.000Z",
    format: "text",
    saved: false,
    viewedAt: null,
    userRating: null,
    views: 100,
    reactions: 10,
    lift: 5,
    erBayes: 0.1,
    velocity: 10,
    velocityZ: 1,
    freshness: 0.8,
    analyticsScore: 70,
    formulaVersion: "aurora-library-v1",
    dataQuality: "high",
    dataMaturity: "mature",
    isHit: true,
    ...overrides,
  };
}

describe("library filters", () => {
  it("returns the complete registry unless the hit-only filter is explicit", () => {
    expect(parseLibraryFilters(new URLSearchParams()).hitOnly).toBe(false);
    expect(parseLibraryFilters(new URLSearchParams("hit=only")).hitOnly).toBe(true);
    expect(parseLibraryFilters(new URLSearchParams("hit=all")).hitOnly).toBe(false);
  });

  it("parses all public filter families with bounded rating and Score kept separate", () => {
    const filters = parseLibraryFilters(new URLSearchParams(
      "channel=7&source=10,20&from=2026-08-01&to=2026-08-05&format=text,video&saved=saved&viewed=viewed&ratingMin=4&ratingMax=5&viewsMin=100&reactionsMin=2&liftMin=5&scoreMin=80&quality=high&maturity=mature&sort=velocity&direction=asc",
    ));
    expect(filters).toMatchObject({
      channelId: 7,
      sourceIds: ["10", "20"],
      formats: ["text", "video"],
      saved: "saved",
      viewed: "viewed",
      ratingMin: 4,
      ratingMax: 5,
      scoreMin: 80,
      sort: "velocity",
      direction: "asc",
    });
  });

  it("filters saved/viewed/rating and analytical ranges without mixing rating with Score", () => {
    const filters = parseLibraryFilters({ saved: "saved", viewed: "viewed", ratingMin: 4, scoreMin: 80, hit: "all" });
    const result = filterAndSortLibraryItems([
      item({ id: "a", saved: true, viewedAt: "2026-08-05T10:00:00Z", userRating: 4, analyticsScore: 85 }),
      item({ id: "b", saved: true, viewedAt: "2026-08-05T10:00:00Z", userRating: 5, analyticsScore: 60 }),
      item({ id: "c", saved: false, viewedAt: "2026-08-05T10:00:00Z", userRating: 5, analyticsScore: 95 }),
    ], filters);
    expect(result.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("sorts missing metrics last in either direction", () => {
    const desc = parseLibraryFilters({ hit: "all", sort: "score", direction: "desc" });
    const asc = parseLibraryFilters({ hit: "all", sort: "score", direction: "asc" });
    const rows = [item({ id: "missing", analyticsScore: null }), item({ id: "high", analyticsScore: 90 }), item({ id: "low", analyticsScore: 20 })];
    expect(filterAndSortLibraryItems(rows, desc).map((entry) => entry.id)).toEqual(["high", "low", "missing"]);
    expect(filterAndSortLibraryItems(rows, asc).map((entry) => entry.id)).toEqual(["low", "high", "missing"]);
  });

  it("keeps only analytically confirmed hits across references, ideas and saved items", () => {
    const filters = parseLibraryFilters({ hit: "only" });
    const result = filterAndSortLibraryItems([
      item({ id: "reference:1", kind: "reference", isHit: true }),
      item({ id: "idea:2", kind: "idea", isHit: false }),
      item({ id: "saved:3", kind: "saved", saved: true, isHit: false }),
      item({ id: "idea:4", kind: "idea", isHit: true }),
      item({ id: "saved:5", kind: "saved", saved: true, isHit: true }),
    ], filters);
    expect(result.map((entry) => entry.id).sort()).toEqual(["idea:4", "reference:1", "saved:5"]);
  });
});
