import { describe, expect, it, vi } from "vitest";
import { immediateE2ePublicationSchedule } from "./e2e-publication-schedule.mjs";

describe("immediate publication fixture clock", () => {
  it("keeps a current-minute slot when the API has at least 30 seconds of headroom", async () => {
    const sleep = vi.fn();
    expect(await immediateE2ePublicationSchedule({ now: () => new Date("2026-09-08T10:20:05Z"), sleep }))
      .toEqual({ scheduledAt: "2026-09-08T10:20:00.000Z", localDate: "2026-09-08", localTime: "10:20", timezone: "UTC", offset: "+00:00", disambiguation: "reject" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits across the minute edge instead of sending a nearly expired schedule", async () => {
    let clock = Date.parse("2026-09-08T10:20:59.999Z");
    const sleep = vi.fn(async (ms) => { clock += ms; });
    const schedule = await immediateE2ePublicationSchedule({ now: () => new Date(clock), sleep });
    expect(sleep).toHaveBeenCalledWith(1);
    expect(schedule.scheduledAt).toBe("2026-09-08T10:21:00.000Z");
    expect(Date.parse(schedule.scheduledAt)).toBeGreaterThanOrEqual(clock + 20_000 - 60_000);
  });

  it("rechecks the wall clock if the process resumes late after waiting", async () => {
    let clock = Date.parse("2026-09-08T23:59:59Z");
    const sleep = vi.fn(async (ms) => { clock += ms + (sleep.mock.calls.length === 1 ? 45_000 : 0); });
    const schedule = await immediateE2ePublicationSchedule({ now: () => new Date(clock), sleep });
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 15_000]);
    expect(schedule.scheduledAt).toBe("2026-09-09T00:01:00.000Z");
  });
});
