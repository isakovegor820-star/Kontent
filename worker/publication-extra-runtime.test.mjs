import { expect, test } from "vitest";

import {
  reconcilePublicationExtraRuntime,
  triggerPublicationExtrasAfterPublish,
} from "./publication-extra-runtime.mjs";

test("confirmed publication activates and dispatches only its project-scoped action", async () => {
  const calls = [];
  const result = await triggerPublicationExtrasAfterPublish({
    pool: { query: async () => ({ rows: [] }) },
    projectId: 7,
    postId: 11,
    enqueue: async () => undefined,
    activate: async (_pool, scope) => {
      calls.push(["activate", scope]);
      return 41;
    },
    reconcile: async (input) => {
      calls.push(["reconcile", input.operationId, input.limit]);
      return { scanned: 1, enqueued: 1, failed: 0 };
    },
  });
  expect(calls).toEqual([
    ["activate", { projectId: 7, postId: 11 }],
    ["reconcile", 41, 1],
  ]);
  expect(result).toEqual({ operationId: 41, scanned: 1, enqueued: 1, failed: 0 });
});

test("publication without follow-up actions does not touch the queue", async () => {
  let reconciled = false;
  const result = await triggerPublicationExtrasAfterPublish({
    pool: {},
    projectId: 1,
    postId: 2,
    enqueue: async () => undefined,
    activate: async () => null,
    reconcile: async () => {
      reconciled = true;
      return {};
    },
  });
  expect(reconciled).toBe(false);
  expect(result).toEqual({ operationId: null, scanned: 0, enqueued: 0, failed: 0 });
});

test("restart reconciliation promotes every confirmed post before replaying outbox", async () => {
  const activated = [];
  let reconciled = false;
  const result = await reconcilePublicationExtraRuntime({
    pool: {
      query: async (sql, values) => {
        expect(sql).toMatch(/post\.status = 'published'/u);
        expect(values).toEqual([25]);
        return { rows: [
          { project_id: 3, post_id: 8 },
          { project_id: 4, post_id: 9 },
        ] };
      },
    },
    enqueue: async () => undefined,
    limit: 25,
    activate: async (_pool, scope) => {
      activated.push(scope);
      return scope.postId + 100;
    },
    reconcile: async ({ limit }) => {
      reconciled = true;
      expect(limit).toBe(25);
      return { scanned: 2, enqueued: 2, failed: 0 };
    },
  });
  expect(activated).toEqual([
    { projectId: 3, postId: 8 },
    { projectId: 4, postId: 9 },
  ]);
  expect(reconciled).toBe(true);
  expect(result).toEqual({
    candidates: 2,
    activated: 2,
    scanned: 2,
    enqueued: 2,
    failed: 0,
  });
});
