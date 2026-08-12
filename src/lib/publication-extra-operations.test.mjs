import { describe, expect, it, vi } from "vitest";

import {
  activateNextPublicationExtra,
  buildPublicationExtraSpecs,
  persistPublicationExtraSpecs,
  persistPublicationReviewTask,
  publicationExtraFingerprint,
} from "./publication-extra-operations.mjs";

const base = {
  projectId: 7,
  publicationOperationId: 11,
  postId: 13,
  channelId: 17,
  providerId: "tg",
  blockSnapshot: {
    contentHash: "a".repeat(64),
    firstComment: {
      delivery: "provider_comment",
      text: "Материалы дела — по ссылке.",
      blockId: 3,
      blockVersion: 2,
    },
  },
  commentsMode: "disabled",
  pinAfterPublish: true,
  capabilities: { firstComment: true, commentToggle: false, pin: true },
};

describe("publication extra operations", () => {
  it("builds deterministic ordered specs and keeps unsupported actions visible", () => {
    const specs = buildPublicationExtraSpecs(base);
    expect(specs.map((item) => [item.kind, item.sequenceIndex, item.initialStatus])).toEqual([
      ["first_comment", 10, "waiting_dependency"],
      ["configure_comments", 20, "unsupported"],
      ["pin", 30, "waiting_dependency"],
    ]);
    expect(buildPublicationExtraSpecs(base)).toEqual(specs);
    expect(new Set(specs.map((item) => item.fingerprint)).size).toBe(3);
    expect(specs[0].requestSnapshot).toMatchObject({
      providerId: "tg",
      text: "Материалы дела — по ссылке.",
      blockVersion: 2,
    });
  });

  it("does not create a provider comment when fallback already appended or skipped it", () => {
    for (const delivery of ["appended", "skipped"]) {
      const specs = buildPublicationExtraSpecs({
        ...base,
        blockSnapshot: { ...base.blockSnapshot, firstComment: { ...base.blockSnapshot.firstComment, delivery } },
        commentsMode: "provider_default",
        pinAfterPublish: false,
      });
      expect(specs).toEqual([]);
    }
  });

  it("hashes canonical snapshots independently from object key order", () => {
    expect(publicationExtraFingerprint({ a: 1, b: { c: 2, d: 3 } }))
      .toBe(publicationExtraFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it("persists each immutable spec and an audit record without queueing unsupported work", async () => {
    let nextId = 40;
    const query = vi.fn(async (sql, values) => {
      if (sql.includes("insert into publication_extra_operations")) {
        return { rows: [{
          id: nextId++, kind: values[4], sequence_index: values[5],
          status: values[9], fingerprint: values[7],
        }] };
      }
      if (sql.includes("insert into audit_events")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const rows = await persistPublicationExtraSpecs({ query }, { ...base, actorUserId: 5 });
    expect(rows).toHaveLength(3);
    expect(query).toHaveBeenCalledTimes(6);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("publication_extra_outbox"))).toBe(false);
  });

  it("stores a timezone-aware review task with deterministic reminder identity", async () => {
    const query = vi.fn(async (sql, values) => {
      if (sql.includes("insert into publication_review_tasks")) {
        expect(values[0]).toBe(7);
        expect(values[4]).toBe("Europe/Amsterdam");
        return { rows: [{ id: "9", review_at: values[3], status: "scheduled", reminder_status: "pending" }] };
      }
      if (sql.includes("insert into audit_events")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const task = await persistPublicationReviewTask({ query }, {
      projectId: 7,
      postId: 13,
      responsibleUserId: 5,
      actorUserId: 5,
      reviewAt: new Date("2026-09-20T10:00:00.000Z"),
      timezone: "Europe/Amsterdam",
    });
    expect(task).toMatchObject({ id: "9", status: "scheduled" });
  });

  it("activates only the next dependency-satisfied operation and creates one durable outbox row", async () => {
    const query = vi.fn(async (sql, values) => {
      if (sql.includes("select extra.id")) {
        expect(values).toEqual([7, 13, ["succeeded", "failed", "skipped", "unsupported", "cancelled"]]);
        return { rows: [{ id: "22", status: "waiting_dependency", sequence_index: 10 }] };
      }
      if (sql.includes("update publication_extra_operations")) return { rows: [] };
      if (sql.includes("insert into publication_extra_outbox")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(activateNextPublicationExtra({ query }, { projectId: 7, postId: 13 })).resolves.toBe(22);
    expect(query).toHaveBeenCalledTimes(3);
  });
});
