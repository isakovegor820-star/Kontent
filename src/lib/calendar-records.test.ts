import { describe, expect, it } from "vitest";

import {
  activePublicationOperationForDraft,
  collapsePublishedDraftDuplicates,
} from "./calendar-records";

describe("calendar publication and draft records", () => {
  it("keeps one operation-linked card instead of a second bare draft card", () => {
    const records = [
      { id: "real-81", serverDraftId: 41, publicationOperationId: 81, operationStatus: "queued" },
      { id: "draft-41", serverDraftId: 41 },
      { id: "draft-42", serverDraftId: 42 },
    ];

    expect(collapsePublishedDraftDuplicates(records).map((record) => record.id)).toEqual([
      "real-81",
      "draft-42",
    ]);
    expect(activePublicationOperationForDraft(records, 41)).toBe(81);
  });

  it("restores the editable draft card after its publication was cancelled", () => {
    const records = [
      { id: "real-81", serverDraftId: 41, publicationOperationId: 81, operationStatus: "cancelled" },
      { id: "draft-41", serverDraftId: 41 },
    ];

    expect(collapsePublishedDraftDuplicates(records).map((record) => record.id)).toContain("draft-41");
    expect(activePublicationOperationForDraft(records, 41)).toBeNull();
  });
});
