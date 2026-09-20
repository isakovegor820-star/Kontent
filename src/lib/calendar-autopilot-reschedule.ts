import type { RealPost } from "./types";
import type { LocalScheduleInput } from "./timezone-schedule";

export type AutopilotCalendarMove = LocalScheduleInput & {
  postId: number;
  scheduleRevision: number;
  scheduledAt: string;
};
type Result =
  | { kind: "saved"; post: Pick<RealPost, "id"> & Partial<RealPost>; queuePending: boolean | null }
  | { kind: "rejected"; error: string; post?: RealPost }
  | { kind: "unconfirmed" };

/** A missing response is not proof of rollback. Read back, but never replay the PATCH. */
export async function rescheduleAutopilotCalendarPost(fetcher: typeof fetch, input: AutopilotCalendarMove): Promise<Result> {
  try {
    const response = await fetcher("/api/autopilot/item/schedule", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify(input), signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json();
    if (response.ok && result.ok && result.postId === input.postId
      && Number.isSafeInteger(result.scheduleRevision) && result.scheduleRevision > input.scheduleRevision
      && result.scheduledAt === input.scheduledAt && result.timezone === input.timezone) {
      return { kind: "saved", queuePending: Boolean(result.queuePending), post: {
        id: input.postId, scheduled_at: result.scheduledAt, schedule_revision: result.scheduleRevision,
        scheduled_timezone: result.timezone, scheduled_offset: result.offset,
        scheduled_disambiguation: result.disambiguation,
      } };
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408) return { kind: "rejected", error: String(result.error ?? "rejected") };
  } catch { /* The server may already have committed. Reconcile through the same project scope. */ }
  try {
    const response = await fetcher(`/api/posts?id=${input.postId}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { kind: "unconfirmed" };
    const result = await response.json();
    const post: RealPost | undefined = result.posts?.find((candidate: RealPost) => candidate.id === input.postId);
    if (!post) return { kind: "unconfirmed" };
    if (post.status === "scheduled" && post.scheduled_at && Number(post.schedule_revision) > input.scheduleRevision
      && Date.parse(post.scheduled_at) === Date.parse(input.scheduledAt)) {
      return { kind: "saved", post, queuePending: null };
    }
    // A timed-out transaction can still be waiting for a database lock. Seeing the old
    // revision now does not prove that it will never commit.
    if (post.status === "scheduled" && Number(post.schedule_revision) <= input.scheduleRevision) return { kind: "unconfirmed" };
    return { kind: "rejected", error: "post_changed", post };
  } catch { return { kind: "unconfirmed" }; }
}
