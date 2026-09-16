import { describe, expect, it, vi } from "vitest";
import { rescheduleAutopilotCalendarPost } from "./calendar-autopilot-reschedule";

const input = { postId: 42, scheduleRevision: 3, scheduledAt: "2030-04-11T10:00:00.000Z", localDate: "2030-04-11", localTime: "12:00", timezone: "Europe/Amsterdam", disambiguation: "reject" as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
describe("Autopilot calendar mutation acknowledgement", () => {
  it("keeps a committed schedule when queue delivery is pending", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ ok: true, ...input, scheduleRevision: 4, queuePending: true, offset: "+02:00" }));
    const result = await rescheduleAutopilotCalendarPost(fetcher, input);
    expect(result).toMatchObject({ kind: "saved", queuePending: true, post: { id: 42, schedule_revision: 4, scheduled_at: input.scheduledAt } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ timezone: "Europe/Amsterdam", scheduleRevision: 3 });
  });
  it("reads back a committed mutation after a lost response without repeating it", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(json({ posts: [{ id: 42, scheduled_at: input.scheduledAt, schedule_revision: 4, status: "scheduled" }] }));
    expect(await rescheduleAutopilotCalendarPost(fetcher, input)).toMatchObject({ kind: "saved", queuePending: null });
    expect(fetcher.mock.calls.map(call => call[1]?.method ?? "GET")).toEqual(["PATCH", "GET"]);
  });
  it("does not claim rollback if both acknowledgement and read-back fail", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("offline"));
    expect(await rescheduleAutopilotCalendarPost(fetcher, input)).toEqual({ kind: "unconfirmed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps a timeout unconfirmed while the database still shows the old revision", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: "timeout" }, 408))
      .mockResolvedValueOnce(json({ posts: [{ id: 42, scheduled_at: "2030-04-10T10:00:00Z", schedule_revision: 3, status: "scheduled" }] }));
    expect(await rescheduleAutopilotCalendarPost(fetcher, input)).toEqual({ kind: "unconfirmed" });
  });
  it("returns the actual competing state after a lost response", async () => {
    const post = { id: 42, scheduled_at: "2030-04-12T10:00:00Z", schedule_revision: 5, status: "scheduled" };
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(json({ posts: [post] }));
    expect(await rescheduleAutopilotCalendarPost(fetcher, input)).toEqual({ kind: "rejected", error: "post_changed", post });
  });
  it("does not retry a confirmed permission or version rejection", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ error: "post_changed" }, 409));
    expect(await rescheduleAutopilotCalendarPost(fetcher, input)).toEqual({ kind: "rejected", error: "post_changed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
