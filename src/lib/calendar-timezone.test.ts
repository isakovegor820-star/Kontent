import { describe, expect, it } from "vitest";

import {
  calendarDateKey,
  calendarDateKeyForInstant,
  calendarDayForInstant,
} from "./calendar-timezone";
import { fmtDateTime, fmtTime } from "./utils";

describe("calendar project timezone", () => {
  it("groups an instant by the project date instead of the browser date", () => {
    const instant = "2026-08-17T21:30:00Z";
    expect(calendarDateKeyForInstant(instant, "Europe/Moscow")).toBe("2026-08-18");
    expect(calendarDateKeyForInstant(instant, "America/New_York")).toBe("2026-08-17");
  });

  it("represents date-only grid values without an offset-sensitive midnight", () => {
    expect(calendarDateKey(calendarDayForInstant("2026-03-29T00:30:00Z", "Europe/Amsterdam")))
      .toBe("2026-03-29");
  });

  it("formats publication labels in the same project timezone", () => {
    const instant = "2026-08-17T21:30:00Z";
    expect(fmtTime(instant, "Europe/Moscow")).toBe("00:30");
    expect(fmtDateTime(instant, "Europe/Moscow")).toBe("18 августа, 00:30");
  });
});
