import { describe, expect, it } from "vitest";

import {
  inspectLocalSchedule,
  localScheduleFieldsForInstant,
  resolveLocalSchedule,
  ScheduleValidationError,
} from "./timezone-schedule";

describe("timezone-aware schedules", () => {
  it("rejects the Europe/Amsterdam spring gap", () => {
    expect(() => resolveLocalSchedule({
      localDate: "2026-03-29",
      localTime: "02:30",
      timezone: "Europe/Amsterdam",
      disambiguation: "reject",
    })).toThrowError(expect.objectContaining({ code: "nonexistent_local_time" }));
  });

  it("requires and preserves an explicit fall-overlap choice", () => {
    const inspected = inspectLocalSchedule({
      localDate: "2026-10-25",
      localTime: "02:30",
      timezone: "Europe/Amsterdam",
    });
    expect(inspected).toEqual({
      kind: "ambiguous",
      earlier: { scheduledAt: "2026-10-25T00:30:00.000Z", offset: "+02:00" },
      later: { scheduledAt: "2026-10-25T01:30:00.000Z", offset: "+01:00" },
    });
    expect(() => resolveLocalSchedule({
      localDate: "2026-10-25",
      localTime: "02:30",
      timezone: "Europe/Amsterdam",
      disambiguation: "reject",
    })).toThrowError(expect.objectContaining({ code: "ambiguous_local_time" }));
    expect(resolveLocalSchedule({
      localDate: "2026-10-25",
      localTime: "02:30",
      timezone: "Europe/Amsterdam",
      disambiguation: "later",
      offset: "+01:00",
    })).toMatchObject({ scheduledAt: "2026-10-25T01:30:00.000Z", offset: "+01:00" });
  });

  it("handles a timezone without DST", () => {
    expect(resolveLocalSchedule({
      localDate: "2026-08-20",
      localTime: "10:15",
      timezone: "Asia/Kolkata",
      disambiguation: "reject",
    })).toMatchObject({ scheduledAt: "2026-08-20T04:45:00.000Z", offset: "+05:30" });
  });

  it("restores the saved wall-clock fields in the saved zone after a browser-zone change", () => {
    expect(localScheduleFieldsForInstant(
      "2026-08-20T08:15:00.000Z",
      "Europe/Amsterdam",
    )).toEqual({
      localDate: "2026-08-20",
      localTime: "10:15",
      timezone: "Europe/Amsterdam",
      offset: "+02:00",
    });
  });

  it("rejects invalid zones, forged instants and forged offsets", () => {
    expect(() => resolveLocalSchedule({
      localDate: "2026-08-20",
      localTime: "10:15",
      timezone: "Mars/Olympus",
      disambiguation: "reject",
    })).toThrowError(ScheduleValidationError);
    expect(() => resolveLocalSchedule({
      localDate: "2026-08-20",
      localTime: "10:15",
      timezone: "Europe/Amsterdam",
      disambiguation: "reject",
      offset: "+09:00",
    })).toThrowError(expect.objectContaining({ code: "schedule_offset_conflict" }));
    expect(() => resolveLocalSchedule({
      localDate: "2026-08-20",
      localTime: "10:15",
      timezone: "Europe/Amsterdam",
      disambiguation: "reject",
    }, "2026-08-20T10:15:00Z")).toThrowError(expect.objectContaining({ code: "schedule_instant_conflict" }));
  });
});
