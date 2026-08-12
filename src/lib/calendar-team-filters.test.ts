import { describe, expect, it } from "vitest";

import {
  calendarAuthorOptions,
  calendarRecordMatches,
  calendarRecordStatus,
} from "./calendar-team-filters";

const records = [
  { authorUserId: 9, authorName: "Яна", calendarStatus: "in_review", status: "draft" },
  { authorUserId: 5, authorName: "Анна", calendarStatus: "approved", status: "draft" },
  { authorUserId: 5, authorName: "Анна", status: "published" },
];

describe("shared calendar team filters", () => {
  it("uses editorial state for drafts and publication state for posts", () => {
    expect(calendarRecordStatus(records[0])).toBe("in_review");
    expect(calendarRecordStatus(records[2])).toBe("published");
  });

  it("combines author and status without leaking another author's material", () => {
    expect(records.filter((record) => calendarRecordMatches(record, {
      author: "5",
      status: "approved",
    }))).toEqual([records[1]]);
  });

  it("deduplicates and sorts server-owned author labels", () => {
    expect(calendarAuthorOptions(records)).toEqual([
      { id: 5, name: "Анна" },
      { id: 9, name: "Яна" },
    ]);
  });
});
