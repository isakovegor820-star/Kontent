import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import { requireSelectedProjectPermission } from "./project-permissions";

type TransactionPool = Pick<Pool, "connect">;
type OnboardingStep = 1 | 2 | 3 | 4 | 5;

type ProgressRow = {
  project_id: number | string;
  step: number | string;
  channel_id: number | string | null;
  first_draft_id: number | string | null;
  skipped_first_source: boolean;
  version: number | string;
  completed_at: Date | string | null;
  updated_at: Date | string;
};

export type OnboardingProgress = {
  projectId: number;
  step: OnboardingStep;
  channelId: number | null;
  firstDraftId: number | null;
  skippedFirstSource: boolean;
  version: number;
  completedAt: string | null;
  updatedAt: string | null;
};

export class OnboardingProgressError extends Error {
  constructor(public readonly code:
    | "bad_step"
    | "channel_required"
    | "telegram_channel_not_ready"
    | "brief_required"
    | "progress_missing"
    | "material_required") {
    super(code);
    this.name = "OnboardingProgressError";
  }
}

function toIso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asStep(value: number): OnboardingStep {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5) {
    throw new OnboardingProgressError("bad_step");
  }
  return value as OnboardingStep;
}

function mapProgress(row: ProgressRow): OnboardingProgress {
  return {
    projectId: Number(row.project_id),
    step: asStep(Number(row.step)),
    channelId: row.channel_id == null ? null : Number(row.channel_id),
    firstDraftId: row.first_draft_id == null ? null : Number(row.first_draft_id),
    skippedFirstSource: row.skipped_first_source === true,
    version: Number(row.version),
    completedAt: toIso(row.completed_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function withTransaction<T>(
  pool: TransactionPool,
  task: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await task(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function readProgress(
  db: Pick<PoolClient, "query">,
  userId: number,
  projectId: number,
  lock = false,
): Promise<ProgressRow | null> {
  const result = await db.query<ProgressRow>(
    `select project_id, step, channel_id, first_draft_id, skipped_first_source,
            version, completed_at, updated_at
       from onboarding_progress
      where user_id = $1 and project_id = $2${lock ? " for update" : ""}`,
    [userId, projectId],
  );
  return result.rows[0] ?? null;
}

async function assertTelegramChannel(
  db: Pick<PoolClient, "query">,
  projectId: number,
  channelId: number,
): Promise<void> {
  const result = await db.query(
    `select id from channels
      where id = $1 and project_id = $2 and network = 'tg'
        and is_active = true and status = 'active'
      limit 1`,
    [channelId, projectId],
  );
  if (!result.rows[0]) throw new OnboardingProgressError("telegram_channel_not_ready");
}

async function assertBrief(
  db: Pick<PoolClient, "query">,
  projectId: number,
  channelId: number,
): Promise<void> {
  const result = await db.query(
    `select 1 from content_brief
      where project_id = $1 and channel_id = $2 and ready = true
      limit 1`,
    [projectId, channelId],
  );
  if (!result.rows[0]) throw new OnboardingProgressError("brief_required");
}

export async function getOnboardingProgress(
  userId: number,
  pool: TransactionPool = getPool(),
): Promise<OnboardingProgress> {
  return withTransaction(pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, userId, "project.read");
    const row = await readProgress(client, userId, membership.projectId);
    if (row) return mapProgress(row);
    return {
      projectId: membership.projectId,
      step: 1,
      channelId: null,
      firstDraftId: null,
      skippedFirstSource: false,
      version: 0,
      completedAt: null,
      updatedAt: null,
    };
  });
}

export async function saveOnboardingProgress(input: {
  userId: number;
  step: number;
  channelId?: number | null;
  skippedFirstSource?: boolean;
  pool?: TransactionPool;
}): Promise<OnboardingProgress> {
  const requestedStep = asStep(input.step);
  return withTransaction(input.pool ?? getPool(), async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.userId, "content.create");
    const existing = await readProgress(client, input.userId, membership.projectId, true);
    const channelId = input.channelId ?? (existing?.channel_id == null ? null : Number(existing.channel_id));
    if (requestedStep >= 3 && channelId == null) {
      throw new OnboardingProgressError("channel_required");
    }
    if (channelId != null) await assertTelegramChannel(client, membership.projectId, channelId);
    if (requestedStep >= 4 && channelId != null) {
      await assertBrief(client, membership.projectId, channelId);
    }

    const result = await client.query<ProgressRow>(
      `insert into onboarding_progress (
         user_id, project_id, step, channel_id, skipped_first_source
       ) values ($1, $2, $3, $4, $5)
       on conflict (user_id) do update
         set project_id = excluded.project_id,
             step = case
               when onboarding_progress.project_id = excluded.project_id
                 then greatest(onboarding_progress.step, excluded.step)
               else excluded.step
             end,
             channel_id = case
               when onboarding_progress.project_id = excluded.project_id
                 then coalesce(excluded.channel_id, onboarding_progress.channel_id)
               else excluded.channel_id
             end,
             first_draft_id = case
               when onboarding_progress.project_id = excluded.project_id
                 then onboarding_progress.first_draft_id
               else null
             end,
             skipped_first_source = case
               when onboarding_progress.project_id = excluded.project_id
                 then onboarding_progress.skipped_first_source or excluded.skipped_first_source
               else excluded.skipped_first_source
             end,
             completed_at = case
               when onboarding_progress.project_id = excluded.project_id
                 then onboarding_progress.completed_at
               else null
             end,
             version = onboarding_progress.version + 1,
             updated_at = now()
       returning project_id, step, channel_id, first_draft_id, skipped_first_source,
                 version, completed_at, updated_at`,
      [
        input.userId,
        membership.projectId,
        requestedStep,
        channelId,
        input.skippedFirstSource === true,
      ],
    );
    return mapProgress(result.rows[0]);
  });
}

export async function completeOnboarding(input: {
  userId: number;
  channelId: number;
  draftId: number;
  pool?: TransactionPool;
}): Promise<{ onboardingCompletedAt: string; progress: OnboardingProgress }> {
  return withTransaction(input.pool ?? getPool(), async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.userId, "content.create");
    const progress = await readProgress(client, input.userId, membership.projectId, true);
    if (!progress || Number(progress.step) < 5) {
      throw new OnboardingProgressError("progress_missing");
    }
    if (Number(progress.channel_id) !== input.channelId) {
      throw new OnboardingProgressError("telegram_channel_not_ready");
    }
    await assertTelegramChannel(client, membership.projectId, input.channelId);
    await assertBrief(client, membership.projectId, input.channelId);

    const draft = await client.query(
      `select draft.id
         from drafts draft
         join draft_destinations destination
           on destination.draft_id = draft.id
          and destination.channel_id = $3
        where draft.id = $1 and draft.project_id = $2 and draft.user_id = $4
          and draft.origin = 'manual' and draft.purpose = 'publishable'
        limit 1`,
      [input.draftId, membership.projectId, input.channelId, input.userId],
    );
    if (!draft.rows[0]) throw new OnboardingProgressError("material_required");

    const saved = await client.query<ProgressRow>(
      `update onboarding_progress
          set step = 5, first_draft_id = $3,
              completed_at = coalesce(completed_at, now()),
              version = version + 1, updated_at = now()
        where user_id = $1 and project_id = $2
        returning project_id, step, channel_id, first_draft_id, skipped_first_source,
                  version, completed_at, updated_at`,
      [input.userId, membership.projectId, input.draftId],
    );
    const user = await client.query<{ onboarding_completed_at: Date | string }>(
      `update users
          set onboarding_completed_at = coalesce(onboarding_completed_at, now())
        where id = $1
        returning onboarding_completed_at`,
      [input.userId],
    );
    if (!saved.rows[0] || !user.rows[0]) throw new Error("onboarding_completion_failed");
    return {
      onboardingCompletedAt: toIso(user.rows[0].onboarding_completed_at)!,
      progress: mapProgress(saved.rows[0]),
    };
  });
}
