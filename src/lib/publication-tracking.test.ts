import { describe, expect, it } from "vitest";

import type { DraftTrackingSelection } from "./draft-types";
import { publicationTrackingUrl, renderPublicationTracking } from "./publication-tracking";

const base: DraftTrackingSelection = {
  shortLinkId: 17,
  shortUrlPath: "/r/abcdefghijklmnopqrst",
  destination: "https://law.example/consultation?utm_source=telegram",
  utmValues: { utm_source: "telegram", utm_campaign: "bankruptcy_august" },
  placement: "cta",
};

describe("publication tracking render", () => {
  it("renders the public short URL into the exact CTA snapshot", () => {
    expect(renderPublicationTracking("Проверенный материал", base, "https://aurora.example/app"))
      .toEqual({
        mainText: "Проверенный материал\n\nПодробнее: https://aurora.example/r/abcdefghijklmnopqrst",
        firstCommentText: null,
        publicUrl: "https://aurora.example/r/abcdefghijklmnopqrst",
      });
  });

  it.each([
    ["post", "Проверенный материал\n\nhttps://aurora.example/r/abcdefghijklmnopqrst"],
    ["source", "Проверенный материал\n\nИсточник: https://aurora.example/r/abcdefghijklmnopqrst"],
  ] as const)("renders %s placement without changing the editable text", (placement, mainText) => {
    expect(renderPublicationTracking("Проверенный материал", { ...base, placement }, "https://aurora.example"))
      .toMatchObject({ mainText, firstCommentText: null });
  });

  it("keeps the post unchanged and freezes a separate first comment", () => {
    expect(renderPublicationTracking(
      "Проверенный материал",
      { ...base, placement: "first_comment" },
      "https://aurora.example",
    )).toEqual({
      mainText: "Проверенный материал",
      firstCommentText: "Подробнее: https://aurora.example/r/abcdefghijklmnopqrst",
      publicUrl: "https://aurora.example/r/abcdefghijklmnopqrst",
    });
  });

  it("builds a direct UTM destination when no short link was requested", () => {
    expect(publicationTrackingUrl({
      ...base,
      shortLinkId: null,
      shortUrlPath: null,
      destination: "https://law.example/consultation?ref=profile",
    }, "https://aurora.example")).toBe(
      "https://law.example/consultation?ref=profile&utm_source=telegram&utm_campaign=bankruptcy_august",
    );
  });

  it("fails closed for a stale short-link binding or unsafe public origin", () => {
    expect(() => publicationTrackingUrl({ ...base, shortUrlPath: "/r/short" }, "https://aurora.example"))
      .toThrow("invalid_short_link_binding");
    expect(() => publicationTrackingUrl(base, "javascript:alert(1)"))
      .toThrow("invalid_public_origin");
  });

  it("does not change text when tracking is absent", () => {
    expect(renderPublicationTracking("Текст\n", null, "https://aurora.example"))
      .toEqual({ mainText: "Текст\n", firstCommentText: null, publicUrl: null });
  });
});
