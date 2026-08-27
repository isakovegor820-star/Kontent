import { describe, expect, it } from "vitest";

import {
  libraryFilterPayload,
  libraryRegistryEmptyState,
  libraryRegistryQuery,
} from "./library-registry-view";

const filters = {
  q: "договор",
  source: "42",
  from: "2026-07-01",
  to: "2026-08-01",
  formats: ["photo" as const, "video" as const],
  saved: "saved" as const,
  viewed: "new" as const,
  ratingMin: "4",
  ratingMax: "5",
  viewsMin: "1000",
  viewsMax: "",
  reactionsMin: "10",
  reactionsMax: "",
  liftMin: "5",
  liftMax: "",
  scoreMin: "80",
  scoreMax: "100",
  qualities: ["high" as const],
  maturities: ["mature" as const],
  sort: "velocity" as const,
  direction: "desc" as const,
  hitOnly: true,
};

describe("library analytical registry client contract", () => {
  it("keeps user rating and analytical Score as separate filter fields", () => {
    expect(libraryFilterPayload(11, filters)).toMatchObject({
      channel: 11,
      ratingMin: 4,
      ratingMax: 5,
      scoreMin: 80,
      scoreMax: 100,
      hit: "only",
    });
  });

  it("sends the same complete filter contract used by snapshot export", () => {
    const params = libraryRegistryQuery(11, filters);
    expect(params.getAll("format")).toEqual(["photo", "video"]);
    expect(params.get("source")).toBe("42");
    expect(params.get("sort")).toBe("velocity");
    expect(params.get("liftMin")).toBe("5");
    expect(params.get("ratingMin")).toBe("4");
    expect(params.get("scoreMin")).toBe("80");
  });

  it("distinguishes a new channel from an empty filtered result", () => {
    const diagnostics = {
      competitorCount: 0,
      sourcePostCount: 0,
      readyIdeaCount: 0,
      pendingIdeaCount: 0,
      savedCount: 0,
      totalItemCount: 0,
      aiEngine: "local",
      aiEngineLabel: "Hermes 3",
      aiConfigured: true,
    };
    expect(libraryRegistryEmptyState(diagnostics, 0)).toMatchObject({
      kind: "competitors",
      title: "Добавь конкурентов для первых примеров",
    });
    expect(libraryRegistryEmptyState({ ...diagnostics, totalItemCount: 4 }, 1)).toMatchObject({
      kind: "filtered",
      title: "По этим условиям ничего нет",
    });
  });
});
