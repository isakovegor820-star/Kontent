import { describe, expect, it } from "vitest";
import { normalizeOperationDestinations, publicationOperationFingerprint } from "./publication-operation";

const base = {
  userId: 7,
  draftId: 41,
  draftVersion: 3,
  text: "Immutable text",
  media: { kind: "image", assetId: 9 },
  destinationIds: [18, 1],
  scheduledAt: "2026-08-03T10:00:00.000Z",
  timezone: "Europe/Moscow",
  options: {},
};

describe("publication operation fingerprint", () => {
  it("is destination-order independent but revision/text/date sensitive", () => {
    const fingerprint = publicationOperationFingerprint(base);
    expect(publicationOperationFingerprint({ ...base, destinationIds: [1, 18, 18] })).toBe(fingerprint);
    expect(publicationOperationFingerprint({ ...base, draftVersion: 4 })).not.toBe(fingerprint);
    expect(publicationOperationFingerprint({ ...base, text: "Edited text" })).not.toBe(fingerprint);
    expect(publicationOperationFingerprint({ ...base, scheduledAt: "2026-08-04T10:00:00.000Z" })).not.toBe(fingerprint);
  });

  it("normalizes invalid and duplicate destination ids", () => {
    expect(normalizeOperationDestinations([18, 1, 18, 0, -1, 1.5])).toEqual([1, 18]);
  });
});
