import type { Pool, PoolClient } from "pg";

import {
  BRAND_DICTIONARY_ENTRY_KINDS,
  type BrandDictionaryEntry,
  type BrandDictionaryEntryKind,
} from "./legal-typographer";
import { requireSelectedProjectPermission } from "./project-permissions";

type Queryable = Pick<PoolClient, "query">;
type TransactionPool = Pick<Pool, "connect">;

export type ProjectBrandDictionaryEntry = Required<Pick<BrandDictionaryEntry, "id" | "term" | "caseSensitive" | "version">> & {
  kind: BrandDictionaryEntryKind;
  replacement: string | null;
  expansion: string | null;
};

export type ProjectBrandDictionary = {
  projectId: number;
  version: number;
  entries: ProjectBrandDictionaryEntry[];
  updatedAt: string | null;
};

export class BrandDictionaryError extends Error {
  readonly code:
    | "invalid_kind"
    | "invalid_term"
    | "invalid_replacement"
    | "invalid_expansion"
    | "invalid_entry_id"
    | "version_conflict"
    | "entry_not_found"
    | "duplicate_term";

  constructor(code: BrandDictionaryError["code"]) {
    super(code);
    this.name = "BrandDictionaryError";
    this.code = code;
  }
}

function normalizeKind(value: unknown): BrandDictionaryEntryKind {
  const kind = String(value ?? "") as BrandDictionaryEntryKind;
  if (!BRAND_DICTIONARY_ENTRY_KINDS.includes(kind)) {
    throw new BrandDictionaryError("invalid_kind");
  }
  return kind;
}

function normalizeText(value: unknown, max: number, code: "invalid_term" | "invalid_replacement" | "invalid_expansion") {
  const normalized = String(value ?? "").normalize("NFC").trim().replace(/[ \t]+/gu, " ");
  if (
    normalized.length < 1
    || normalized.length > max
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) throw new BrandDictionaryError(code);
  return normalized;
}

function optionalText(value: unknown, max: number, code: "invalid_replacement" | "invalid_expansion") {
  if (value == null || value === "") return null;
  return normalizeText(value, max, code);
}

function positiveInteger(value: unknown, code: "invalid_entry_id" | "version_conflict") {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new BrandDictionaryError(code);
  return parsed;
}

function normalizeEntry(input: {
  kind: unknown;
  term: unknown;
  replacement: unknown;
  expansion: unknown;
  caseSensitive: unknown;
}) {
  const kind = normalizeKind(input.kind);
  const term = normalizeText(input.term, 240, "invalid_term");
  const replacement = optionalText(input.replacement, 240, "invalid_replacement");
  const expansion = optionalText(input.expansion, 500, "invalid_expansion");
  if ((kind === "allowed" || kind === "exception") && replacement !== null) {
    throw new BrandDictionaryError("invalid_replacement");
  }
  if (
    (kind === "canonical" || kind === "prohibited" || kind === "abbreviation")
    && replacement === null
  ) throw new BrandDictionaryError("invalid_replacement");
  if (typeof input.caseSensitive !== "boolean") throw new BrandDictionaryError("invalid_term");
  return { kind, term, replacement, expansion, caseSensitive: input.caseSensitive };
}

async function withTransaction<T>(pool: TransactionPool, task: (client: PoolClient) => Promise<T>) {
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

function entryView(row: Record<string, unknown>): ProjectBrandDictionaryEntry {
  return {
    id: Number(row.id),
    kind: String(row.kind) as BrandDictionaryEntryKind,
    term: String(row.term),
    replacement: row.replacement == null ? null : String(row.replacement),
    expansion: row.expansion == null ? null : String(row.expansion),
    caseSensitive: row.case_sensitive === true,
    version: Number(row.version),
  };
}

async function readDictionaryByProject(db: Queryable, projectId: number): Promise<ProjectBrandDictionary> {
  const [dictionaryResult, entriesResult] = await Promise.all([
    db.query<{ version: number | string; updated_at: Date | string }>(
      `select version, updated_at
         from project_brand_dictionaries
        where project_id = $1`,
      [projectId],
    ),
    db.query(
      `select id, kind, term, replacement, expansion, case_sensitive, version
         from project_brand_dictionary_entries
        where project_id = $1 and is_active = true
        order by kind, lower(term), id`,
      [projectId],
    ),
  ]);
  const dictionary = dictionaryResult.rows[0];
  return {
    projectId,
    version: dictionary ? Number(dictionary.version) : 1,
    entries: entriesResult.rows.map((row) => entryView(row as Record<string, unknown>)),
    updatedAt: dictionary ? new Date(dictionary.updated_at).toISOString() : null,
  };
}

async function ensureAndLockDictionary(
  client: PoolClient,
  projectId: number,
  actorUserId: number,
  expectedVersion: number,
) {
  await client.query(
    `insert into project_brand_dictionaries
       (project_id, version, created_by_user_id, updated_by_user_id)
     values ($1, 1, $2, $2)
     on conflict (project_id) do nothing`,
    [projectId, actorUserId],
  );
  const row = (await client.query<{ version: number | string }>(
    `select version
       from project_brand_dictionaries
      where project_id = $1
      for update`,
    [projectId],
  )).rows[0];
  if (!row || Number(row.version) !== expectedVersion) {
    throw new BrandDictionaryError("version_conflict");
  }
}

async function advanceDictionaryVersion(client: PoolClient, projectId: number, actorUserId: number) {
  const row = (await client.query<{ version: number | string; updated_at: Date | string }>(
    `update project_brand_dictionaries
        set version = version + 1, updated_by_user_id = $2, updated_at = now()
      where project_id = $1
      returning version, updated_at`,
    [projectId, actorUserId],
  )).rows[0];
  if (!row) throw new BrandDictionaryError("version_conflict");
  return { version: Number(row.version), updatedAt: new Date(row.updated_at).toISOString() };
}

function databaseCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

export async function getProjectBrandDictionary(db: Queryable, actorUserId: number) {
  const membership = await requireSelectedProjectPermission(db, actorUserId, "project.read");
  return readDictionaryByProject(db, membership.projectId);
}

/** Internal server-only read used by the typographer and publication recheck. */
export async function getBrandDictionarySnapshotForProject(db: Queryable, projectId: number) {
  return readDictionaryByProject(db, projectId);
}

export async function createProjectBrandDictionaryEntry(input: {
  pool: TransactionPool;
  actorUserId: number;
  expectedDictionaryVersion: unknown;
  kind: unknown;
  term: unknown;
  replacement: unknown;
  expansion: unknown;
  caseSensitive: unknown;
  requestId?: string | null;
}) {
  const expectedDictionaryVersion = positiveInteger(input.expectedDictionaryVersion, "version_conflict");
  const normalized = normalizeEntry(input);
  try {
    return await withTransaction(input.pool, async (client) => {
      const membership = await requireSelectedProjectPermission(client, input.actorUserId, "project.manage");
      await ensureAndLockDictionary(client, membership.projectId, input.actorUserId, expectedDictionaryVersion);
      const inserted = await client.query(
        `insert into project_brand_dictionary_entries
           (project_id, kind, term, replacement, expansion, case_sensitive,
            created_by_user_id, updated_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $7)
         returning id, kind, term, replacement, expansion, case_sensitive, version`,
        [
          membership.projectId,
          normalized.kind,
          normalized.term,
          normalized.replacement,
          normalized.expansion,
          normalized.caseSensitive,
          input.actorUserId,
        ],
      );
      const entry = entryView(inserted.rows[0] as Record<string, unknown>);
      const dictionary = await advanceDictionaryVersion(client, membership.projectId, input.actorUserId);
      await client.query(
        `insert into audit_events
           (project_id, actor_user_id, action, entity_type, entity_id,
            after_version, safe_data, request_id)
         values ($1, $2, 'brand_dictionary.entry.created', 'brand_dictionary_entry', $3,
                 $4, jsonb_build_object('kind', $5::text, 'dictionary_version', $6::bigint), $7)`,
        [
          membership.projectId,
          input.actorUserId,
          String(entry.id),
          entry.version,
          entry.kind,
          dictionary.version,
          input.requestId?.slice(0, 128) ?? null,
        ],
      );
      return { projectId: membership.projectId, dictionaryVersion: dictionary.version, entry };
    });
  } catch (error) {
    if (databaseCode(error) === "23505") throw new BrandDictionaryError("duplicate_term");
    throw error;
  }
}

export async function updateProjectBrandDictionaryEntry(input: {
  pool: TransactionPool;
  actorUserId: number;
  entryId: unknown;
  expectedEntryVersion: unknown;
  expectedDictionaryVersion: unknown;
  kind: unknown;
  term: unknown;
  replacement: unknown;
  expansion: unknown;
  caseSensitive: unknown;
  requestId?: string | null;
}) {
  const entryId = positiveInteger(input.entryId, "invalid_entry_id");
  const expectedEntryVersion = positiveInteger(input.expectedEntryVersion, "version_conflict");
  const expectedDictionaryVersion = positiveInteger(input.expectedDictionaryVersion, "version_conflict");
  const normalized = normalizeEntry(input);
  try {
    return await withTransaction(input.pool, async (client) => {
      const membership = await requireSelectedProjectPermission(client, input.actorUserId, "project.manage");
      await ensureAndLockDictionary(client, membership.projectId, input.actorUserId, expectedDictionaryVersion);
      const locked = (await client.query<{ version: number | string; kind: string }>(
        `select version, kind
           from project_brand_dictionary_entries
          where id = $1 and project_id = $2 and is_active = true
          for update`,
        [entryId, membership.projectId],
      )).rows[0];
      if (!locked) throw new BrandDictionaryError("entry_not_found");
      if (Number(locked.version) !== expectedEntryVersion) throw new BrandDictionaryError("version_conflict");
      const updated = await client.query(
        `update project_brand_dictionary_entries
            set kind = $3, term = $4, replacement = $5, expansion = $6,
                case_sensitive = $7, version = version + 1,
                updated_by_user_id = $8, updated_at = now()
          where id = $1 and project_id = $2 and is_active = true
          returning id, kind, term, replacement, expansion, case_sensitive, version`,
        [
          entryId,
          membership.projectId,
          normalized.kind,
          normalized.term,
          normalized.replacement,
          normalized.expansion,
          normalized.caseSensitive,
          input.actorUserId,
        ],
      );
      const entry = entryView(updated.rows[0] as Record<string, unknown>);
      const dictionary = await advanceDictionaryVersion(client, membership.projectId, input.actorUserId);
      await client.query(
        `insert into audit_events
           (project_id, actor_user_id, action, entity_type, entity_id,
            before_version, after_version, safe_data, request_id)
         values ($1, $2, 'brand_dictionary.entry.updated', 'brand_dictionary_entry', $3,
                 $4, $5, jsonb_build_object('from_kind', $6::text, 'to_kind', $7::text,
                                             'dictionary_version', $8::bigint), $9)`,
        [
          membership.projectId,
          input.actorUserId,
          String(entryId),
          expectedEntryVersion,
          entry.version,
          locked.kind,
          entry.kind,
          dictionary.version,
          input.requestId?.slice(0, 128) ?? null,
        ],
      );
      return { projectId: membership.projectId, dictionaryVersion: dictionary.version, entry };
    });
  } catch (error) {
    if (databaseCode(error) === "23505") throw new BrandDictionaryError("duplicate_term");
    throw error;
  }
}

export async function deleteProjectBrandDictionaryEntry(input: {
  pool: TransactionPool;
  actorUserId: number;
  entryId: unknown;
  expectedEntryVersion: unknown;
  expectedDictionaryVersion: unknown;
  requestId?: string | null;
}) {
  const entryId = positiveInteger(input.entryId, "invalid_entry_id");
  const expectedEntryVersion = positiveInteger(input.expectedEntryVersion, "version_conflict");
  const expectedDictionaryVersion = positiveInteger(input.expectedDictionaryVersion, "version_conflict");
  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "project.manage");
    await ensureAndLockDictionary(client, membership.projectId, input.actorUserId, expectedDictionaryVersion);
    const deleted = (await client.query<{ version: number | string; kind: string }>(
      `update project_brand_dictionary_entries
          set is_active = false, version = version + 1,
              updated_by_user_id = $4, updated_at = now()
        where id = $1 and project_id = $2 and is_active = true and version = $3
        returning version, kind`,
      [entryId, membership.projectId, expectedEntryVersion, input.actorUserId],
    )).rows[0];
    if (!deleted) {
      const exists = await client.query(
        `select 1 from project_brand_dictionary_entries
          where id = $1 and project_id = $2 and is_active = true`,
        [entryId, membership.projectId],
      );
      if (!exists.rows[0]) throw new BrandDictionaryError("entry_not_found");
      throw new BrandDictionaryError("version_conflict");
    }
    const dictionary = await advanceDictionaryVersion(client, membership.projectId, input.actorUserId);
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id,
          before_version, after_version, safe_data, request_id)
       values ($1, $2, 'brand_dictionary.entry.deleted', 'brand_dictionary_entry', $3,
               $4, $5, jsonb_build_object('kind', $6::text, 'dictionary_version', $7::bigint), $8)`,
      [
        membership.projectId,
        input.actorUserId,
        String(entryId),
        expectedEntryVersion,
        Number(deleted.version),
        deleted.kind,
        dictionary.version,
        input.requestId?.slice(0, 128) ?? null,
      ],
    );
    return { projectId: membership.projectId, dictionaryVersion: dictionary.version, entryId };
  });
}
