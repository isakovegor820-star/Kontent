import { QueueEvents, type ConnectionOptions } from "bullmq";
import type { Pool, PoolClient } from "pg";

import { refreshOpportunitySnapshots } from "./content-intelligence";
import { getPool } from "./db";
import { getStatsQueue, redisProducerConnectionOptions, STATS_QUEUE } from "./queue";
import { requireSelectedProjectPermission } from "./project-permissions";

type Queryable = Pick<Pool | PoolClient, "query">;
export type TodaySource = "reviews" | "opportunities" | "results";
export type TodayRefreshSourceResult = {
  source: TodaySource;
  status: "success" | "error";
  errorCode: string | null;
};
export type TodayRefreshResult = {
  availability: "ready" | "partial" | "unavailable";
  sources: TodayRefreshSourceResult[];
  completedAt: string;
};

export class TodayRefreshError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "TodayRefreshError";
  }
}

type RefreshDependencies = {
  opportunities: (input: { actorUserId: number; channelId: number }) => Promise<unknown>;
  results: (input: { actorUserId: number; projectId: number; channelId: number }) => Promise<unknown>;
};

async function refreshResultsThroughWorker(input: { actorUserId: number; projectId: number; channelId: number }) {
  const queue = getStatsQueue();
  const events = new QueueEvents(STATS_QUEUE, {
    connection: {
      ...redisProducerConnectionOptions(),
      maxRetriesPerRequest: null,
    } as unknown as ConnectionOptions,
  });
  try {
    await events.waitUntilReady();
    const job = await queue.add(
      "collect",
      { userId: input.actorUserId, projectId: input.projectId, channelId: input.channelId },
      {
        jobId: `stats-collect-${input.projectId}`,
        attempts: 2,
        backoff: { type: "fixed", delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    await job.waitUntilFinished(events, 25_000);
  } finally {
    await events.close().catch(() => undefined);
  }
}

const DEFAULT_DEPENDENCIES: RefreshDependencies = {
  opportunities: ({ actorUserId, channelId }) => refreshOpportunitySnapshots({ actorUserId, channelId }),
  results: refreshResultsThroughWorker,
};

async function resolveScope(db: Queryable, actorUserId: number, channelId: number) {
  const membership = await requireSelectedProjectPermission(db, actorUserId, "project.read");
  const channel = (await db.query<{ id: string }>(
    `select id from channels
      where id = $1 and project_id = $2 and is_active = true and status = 'active'`,
    [channelId, membership.projectId],
  )).rows[0];
  if (!channel) throw new TodayRefreshError("channel_not_found");
  const flag = (await db.query<{ enabled: boolean }>(
    `select enabled from channel_feature_flags
      where project_id = $1 and channel_id = $2 and feature_key = 'content_intelligence_release_1'`,
    [membership.projectId, channelId],
  )).rows[0];
  if (flag?.enabled !== true && !(process.env.NODE_ENV !== "production" && process.env.AURORA_RELEASE1_DEV_ENABLED === "true")) {
    throw new TodayRefreshError("temporarily_disabled");
  }
  return { projectId: membership.projectId, channelId };
}

async function recordAttempt(
  db: Queryable,
  scope: { projectId: number; channelId: number },
  result: TodayRefreshSourceResult,
) {
  await db.query(
    `insert into today_source_refreshes
       (project_id, channel_id, source, last_attempt_state, last_attempt_at,
        last_success_at, last_error_code, updated_at)
     values ($1, $2, $3, $4, now(),
             case when $4 = 'success' then now() else null end, $5, now())
     on conflict (project_id, channel_id, source) do update
       set last_attempt_state = excluded.last_attempt_state,
           last_attempt_at = excluded.last_attempt_at,
           last_success_at = case when excluded.last_attempt_state = 'success'
                                  then excluded.last_attempt_at
                                  else today_source_refreshes.last_success_at end,
           last_error_code = excluded.last_error_code,
           updated_at = now()`,
    [scope.projectId, scope.channelId, result.source, result.status, result.errorCode],
  );
}

function safeErrorCode(source: TodaySource): string {
  return source === "reviews" ? "reviews_refresh_failed"
    : source === "opportunities" ? "opportunities_refresh_failed"
      : "results_refresh_failed";
}

/** Explicit mutation path. GET /api/today remains a side-effect-free projection. */
export async function refreshTodaySources(
  input: { actorUserId: number; channelId: number },
  db: Queryable = getPool(),
  dependencies: RefreshDependencies = DEFAULT_DEPENDENCIES,
): Promise<TodayRefreshResult> {
  if (!Number.isSafeInteger(input.channelId) || input.channelId <= 0) {
    throw new TodayRefreshError("bad_channel");
  }
  const scope = await resolveScope(db, input.actorUserId, input.channelId);
  const tasks: Array<[TodaySource, () => Promise<unknown>]> = [
    ["reviews", async () => db.query(
      `select 1 from drafts draft
        left join draft_destinations destination
          on destination.draft_id = draft.id and destination.channel_id = $2
       where draft.project_id = $1 limit 1`,
      [scope.projectId, scope.channelId],
    )],
    ["opportunities", () => dependencies.opportunities({
      actorUserId: input.actorUserId,
      channelId: scope.channelId,
    })],
    ["results", () => dependencies.results({
      actorUserId: input.actorUserId,
      projectId: scope.projectId,
      channelId: scope.channelId,
    })],
  ];
  const settled = await Promise.all(tasks.map(async ([source, task]): Promise<TodayRefreshSourceResult> => {
    try {
      await task();
      return { source, status: "success", errorCode: null };
    } catch {
      return { source, status: "error", errorCode: safeErrorCode(source) };
    }
  }));
  await Promise.all(settled.map((result) => recordAttempt(db, scope, result).catch(() => undefined)));
  const successful = settled.filter((result) => result.status === "success").length;
  return {
    availability: successful === 0 ? "unavailable" : successful === settled.length ? "ready" : "partial",
    sources: settled,
    completedAt: new Date().toISOString(),
  };
}
