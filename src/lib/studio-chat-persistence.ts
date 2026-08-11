import { getPool } from "./db";
import {
  parseStudioChatSession,
  serializeStudioChatSession,
  type StudioChatSession,
} from "./studio-chat-session";

export const MAX_STUDIO_CHAT_PAYLOAD_BYTES = 8_000_000;

type StudioChatRow = {
  payload: unknown;
  revision: string | number;
  updated_at: Date | string;
};

export type StoredStudioChatSession = {
  payload: unknown;
  revision: number;
  updatedAt: string;
};

export type StudioChatSaveInput = {
  expectedRevision: number;
  payload: unknown;
  session: StudioChatSession;
};

export class StudioChatPersistenceError extends Error {
  constructor(public readonly code: "invalid_revision" | "invalid_session" | "payload_too_large") {
    super(code);
    this.name = "StudioChatPersistenceError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedPayload(owner: number, session: StudioChatSession): unknown {
  return JSON.parse(serializeStudioChatSession(owner, session)) as unknown;
}

function storedRow(owner: number, row: StudioChatRow | undefined): StoredStudioChatSession | null {
  if (!row) return null;
  const raw = JSON.stringify(row.payload);
  const session = parseStudioChatSession(raw, owner);
  const revision = Number(row.revision);
  const updatedAt = new Date(row.updated_at).toISOString();
  if (!session || !Number.isSafeInteger(revision) || revision <= 0) return null;
  return { payload: normalizedPayload(owner, session), revision, updatedAt };
}

export function parseStudioChatSaveInput(value: unknown, owner: number): StudioChatSaveInput {
  if (!record(value)) throw new StudioChatPersistenceError("invalid_session");
  const expectedRevision = Number(value.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new StudioChatPersistenceError("invalid_revision");
  }
  const raw = JSON.stringify(value.session ?? null);
  if (Buffer.byteLength(raw, "utf8") > MAX_STUDIO_CHAT_PAYLOAD_BYTES) {
    throw new StudioChatPersistenceError("payload_too_large");
  }
  const session = parseStudioChatSession(raw, owner);
  if (!session) throw new StudioChatPersistenceError("invalid_session");
  const payload = normalizedPayload(owner, session);
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_STUDIO_CHAT_PAYLOAD_BYTES) {
    throw new StudioChatPersistenceError("payload_too_large");
  }
  return { expectedRevision, payload, session };
}

export async function loadStudioChatSessionForUser(userId: number): Promise<StoredStudioChatSession | null> {
  const result = await getPool().query<StudioChatRow>(
    `select payload, revision, updated_at
       from studio_chat_sessions
      where user_id = $1`,
    [userId],
  );
  return storedRow(userId, result.rows[0]);
}

export async function saveStudioChatSessionForUser(
  userId: number,
  input: StudioChatSaveInput,
): Promise<
  | { saved: true; session: StoredStudioChatSession }
  | { saved: false; current: StoredStudioChatSession | null }
> {
  const result = await getPool().query<StudioChatRow>(
    `with updated as (
       update studio_chat_sessions
          set payload = $2::jsonb,
              revision = revision + 1,
              updated_at = now()
        where user_id = $1
          and revision = $3::bigint
          and $3::bigint > 0
       returning payload, revision, updated_at
     ), inserted as (
       insert into studio_chat_sessions (user_id, payload, revision, updated_at)
       select $1, $2::jsonb, 1, now()
        where $3::bigint = 0
          and not exists (select 1 from studio_chat_sessions where user_id = $1)
       on conflict (user_id) do nothing
       returning payload, revision, updated_at
     )
     select payload, revision, updated_at from updated
     union all
     select payload, revision, updated_at from inserted`,
    [userId, JSON.stringify(input.payload), input.expectedRevision],
  );
  const saved = storedRow(userId, result.rows[0]);
  if (saved) return { saved: true, session: saved };
  return { saved: false, current: await loadStudioChatSessionForUser(userId) };
}
