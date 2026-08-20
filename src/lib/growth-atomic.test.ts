import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  resolveChannel: vi.fn(),
}));

vi.mock("./db", () => ({ getPool: mocks.getPool }));
vi.mock("./project-permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("./project-permissions")>(),
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));
vi.mock("./autopilot", () => ({ resolveChannel: mocks.resolveChannel }));

import { ensureGrowthBoard } from "./growth";
import { ProjectAccessError } from "./project-permissions";

type StoredMove = {
  id: number;
  project_id: number;
  channel_id: number;
  week_start: string;
  kind: string;
  status: string;
  confidence: string;
  title: string;
  reason: string;
  prompt: string;
  action_href: string;
  source_kind: string | null;
  source_id: string | null;
  source_label: string | null;
  fingerprint: string;
  missing_slots: number | null;
};

function atomicPool(options: { failActionUpdateOnce?: boolean } = {}) {
  const committed: StoredMove[] = [];
  let nextId = 1;
  let lockTail = Promise.resolve();
  let failActionUpdateOnce = options.failActionUpdateOnce === true;

  const readSignals = async (sql: string) => {
    if (sql.includes("from posts")) return { rows: sql.includes("count(*)") ? [{ n: "0" }] : [] };
    if (sql.includes("from competitors")) return { rows: [{ n: "0" }] };
    if (sql.includes("from competitor_posts")) return { rows: sql.includes("percentile_cont") ? [{ weekly: null }] : [] };
    if (sql.includes("from site_analysis_jobs")) return { rows: [] };
    if (sql.includes("from audience_questions")) {
      return { rows: [{ id: "91", question: "Как выбрать формат?" }] };
    }
    throw new Error(`unexpected pool query: ${sql}`);
  };

  const pool = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("from growth_moves")) {
        return { rows: committed.filter((move) => move.week_start === String(values?.[1])) };
      }
      return readSignals(sql);
    }),
    connect: vi.fn(async () => {
      const staged: StoredMove[] = [];
      let unlock: (() => void) | null = null;
      return {
        query: vi.fn(async (sql: string, values?: unknown[]) => {
          if (sql === "begin") return { rows: [] };
          if (sql.includes("pg_advisory_xact_lock")) {
            const previous = lockTail;
            lockTail = new Promise<void>((resolve) => { unlock = resolve; });
            await previous;
            return { rows: [] };
          }
          if (sql.includes("from growth_moves")) {
            const week = String(values?.[1]);
            return { rows: [...committed, ...staged].filter((move) => move.week_start === week) };
          }
          if (sql.includes("insert into growth_moves")) {
            const fingerprint = String(values?.[11]);
            if (![...committed, ...staged].some((move) => move.fingerprint === fingerprint)) {
              staged.push({
                id: nextId++, project_id: Number(values?.[0]), channel_id: Number(values?.[1]),
                week_start: String(values?.[2]), kind: String(values?.[3]), status: "open",
                confidence: String(values?.[4]), title: String(values?.[5]), reason: String(values?.[6]),
                prompt: String(values?.[7]), action_href: "/app/growth", source_kind: values?.[8] == null ? null : String(values[8]),
                source_id: values?.[9] == null ? null : String(values[9]), source_label: values?.[10] == null ? null : String(values[10]),
                fingerprint, missing_slots: values?.[12] == null ? null : Number(values[12]),
              });
            }
            return { rows: [] };
          }
          if (sql.includes("update growth_moves")) {
            if (failActionUpdateOnce) {
              failActionUpdateOnce = false;
              throw new Error("after_insert_failure");
            }
            const move = staged.find((candidate) => candidate.id === Number(values?.[0]))
              || committed.find((candidate) => candidate.id === Number(values?.[0]));
            if (move) move.action_href = String(values?.[1]);
            return { rows: [] };
          }
          if (sql === "commit") {
            committed.push(...staged.splice(0));
            unlock?.();
            return { rows: [] };
          }
          if (sql === "rollback") {
            staged.splice(0);
            unlock?.();
            return { rows: [] };
          }
          throw new Error(`unexpected transaction query: ${sql}`);
        }),
        release: vi.fn(),
      };
    }),
  };
  return { pool, committed };
}

describe("atomic Growth move creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 31, userId: 7, role: "owner", version: 1 });
    mocks.resolveChannel.mockResolvedValue(44);
  });

  it("converges 20 concurrent ensure requests on one committed set without placeholder URLs", async () => {
    const state = atomicPool();
    mocks.getPool.mockReturnValue(state.pool);
    const boards = await Promise.all(Array.from({ length: 20 }, () => ensureGrowthBoard({
      actorUserId: 7,
      channelId: 44,
    })));

    expect(state.committed).toHaveLength(1);
    expect(new Set(boards.flatMap((board) => board.moves.map((move) => move.id)))).toEqual(new Set([1]));
    expect(state.committed[0]).toMatchObject({ project_id: 31, channel_id: 44 });
    expect(state.committed[0].action_href).not.toBe("/app/growth");
    expect(state.pool.connect).toHaveBeenCalledTimes(20);
    const siteQuery = state.pool.query.mock.calls.find(([sql]) => String(sql).includes("from site_analysis_jobs"));
    expect(String(siteQuery?.[0])).toContain("j.project_id = $1");
    expect(String(siteQuery?.[0])).not.toContain("project_members");
    expect(siteQuery?.[1]?.[0]).toBe(31);
  });

  it("rolls back an error after insert and a retry creates the complete set", async () => {
    const state = atomicPool({ failActionUpdateOnce: true });
    mocks.getPool.mockReturnValue(state.pool);
    await expect(ensureGrowthBoard({ actorUserId: 7, channelId: 44 })).rejects.toThrow("after_insert_failure");
    expect(state.committed).toEqual([]);

    const retry = await ensureGrowthBoard({ actorUserId: 7, channelId: 44 });
    expect(retry.moves).toHaveLength(1);
    expect(state.committed).toHaveLength(1);
    expect(state.committed[0].action_href).not.toBe("/app/growth");
  });

  it("does not open a transaction when the selected project permission is denied", async () => {
    const state = atomicPool();
    mocks.getPool.mockReturnValue(state.pool);
    mocks.requireSelectedProjectPermission.mockRejectedValueOnce(new ProjectAccessError("permission_denied"));

    await expect(ensureGrowthBoard({ actorUserId: 7, channelId: 44 })).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(state.pool.connect).not.toHaveBeenCalled();
    expect(state.committed).toEqual([]);
  });
});
