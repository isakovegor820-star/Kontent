import { describe, expect, it } from "vitest";

import { ScheduleValidationError } from "./timezone-schedule";
import {
  resolveCalendarDayMove,
  withOptimisticCalendarSchedule,
} from "./calendar-drag-reschedule";

describe("calendar day drag reschedule", () => {
  it("moves only the local date and keeps the local publication time", () => {
    expect(resolveCalendarDayMove({
      scheduledAt: "2026-08-20T08:30:00.000Z",
      targetDay: new Date(2026, 7, 21),
      timezone: "Europe/Amsterdam",
    })).toMatchObject({
      scheduledAt: "2026-08-21T08:30:00.000Z",
      localDate: "2026-08-21",
      localTime: "10:30",
      timezone: "Europe/Amsterdam",
    });
  });

  it("preserves an explicit DST choice when the target time is repeated", () => {
    expect(resolveCalendarDayMove({
      scheduledAt: "2026-10-24T00:30:00.000Z",
      targetDay: new Date(2026, 9, 25),
      timezone: "Europe/Amsterdam",
      disambiguation: "later",
    })).toMatchObject({
      scheduledAt: "2026-10-25T01:30:00.000Z",
      localDate: "2026-10-25",
      localTime: "02:30",
      disambiguation: "later",
      offset: "+01:00",
    });
  });

  it("rejects a target time that does not exist during the DST jump", () => {
    expect(() => resolveCalendarDayMove({
      scheduledAt: "2026-03-28T01:30:00.000Z",
      targetDay: new Date(2026, 2, 29),
      timezone: "Europe/Amsterdam",
    })).toThrowError(new ScheduleValidationError("nonexistent_local_time"));
  });

  it("clears an optimistic move after success and rolls it back after failure", async () => {
    const events: string[] = [];
    await expect(withOptimisticCalendarSchedule({
      apply: () => events.push("apply"),
      persist: async () => {
        events.push("persist");
        return "saved";
      },
      clear: () => events.push("clear"),
    })).resolves.toBe("saved");
    expect(events).toEqual(["apply", "persist", "clear"]);

    events.length = 0;
    await expect(withOptimisticCalendarSchedule({
      apply: () => events.push("apply"),
      persist: async () => {
        events.push("persist");
        throw new Error("offline");
      },
      clear: () => events.push("rollback"),
    })).rejects.toThrow("offline");
    expect(events).toEqual(["apply", "persist", "rollback"]);
  });
});
