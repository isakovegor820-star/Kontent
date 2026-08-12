import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { getBrandDictionarySnapshotForProject } from "./brand-dictionary-service";
import {
  analyzeLegalTypography,
  applyTypographySuggestions,
  TYPOGRAPHY_RULES_VERSION,
  type TypographySuggestion,
} from "./legal-typographer";
import { requireSelectedProjectPermission } from "./project-permissions";

type TransactionPool = Pick<Pool, "connect">;
type Queryable = Pick<PoolClient, "query">;

const MAX_TEXT_LENGTH = 50_000;
const MAX_SUGGESTIONS = 2_000;
const MAX_SAFE_PASSES = 64;
const REQUEST_KEY = /^[A-Za-z0-9._:-]{16,96}$/u;
const SUGGESTION_ID = /^typ-[a-z0-9]+$/u;

export class TypographyServiceError extends Error {
  readonly code:
    | "invalid_text"
    | "invalid_request_key"
    | "invalid_draft"
    | "dictionary_version_conflict"
    | "stale_suggestions"
    | "selection_conflict"
    | "request_conflict"
    | "run_not_found"
    | "current_text_mismatch"
    | "nothing_to_undo";

  constructor(code: TypographyServiceError["code"]) {
    super(code);
    this.name = "TypographyServiceError";
    this.code = code;
  }
}

export class TypographyPublicationError extends Error {
  readonly code = "typography_review_required" as const;
  readonly dictionaryVersion: number;
  readonly suggestionCount: number;

  constructor(dictionaryVersion: number, suggestionCount: number) {
    super("typography_review_required");
    this.name = "TypographyPublicationError";
    this.dictionaryVersion = dictionaryVersion;
    this.suggestionCount = suggestionCount;
  }
}

export type PublicationTypographySnapshot = {
  rulesVersion: typeof TYPOGRAPHY_RULES_VERSION;
  dictionaryVersion: number;
  textHash: string;
  status: "clean" | "reviewed" | "published_as_is";
  suggestionCount: number;
  reviewRunId: number | null;
};

function textHash(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function typographyRequestHash(input: {
  draftId: number | null;
  sourceTextHash: string;
  dictionaryVersion: number;
  acceptedSuggestionIds: "safe" | string[];
  rejectedSuggestionIds: string[];
  formatQuotes: boolean;
}) {
  const accepted = input.acceptedSuggestionIds === "safe"
    ? "safe"
    : [...input.acceptedSuggestionIds].sort();
  const rejected = [...input.rejectedSuggestionIds].sort();
  return textHash(JSON.stringify({
    draftId: input.draftId,
    sourceTextHash: input.sourceTextHash,
    dictionaryVersion: input.dictionaryVersion,
    acceptedSuggestionIds: accepted,
    rejectedSuggestionIds: rejected,
    formatQuotes: input.formatQuotes,
  }));
}

function normalizeText(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_TEXT_LENGTH || value.includes("\0")) {
    throw new TypographyServiceError("invalid_text");
  }
  return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}

function normalizeRequestKey(value: unknown) {
  const requestKey = String(value ?? "").trim();
  if (!REQUEST_KEY.test(requestKey)) throw new TypographyServiceError("invalid_request_key");
  return requestKey;
}

function optionalDraftId(value: unknown) {
  if (value == null || value === "") return null;
  const draftId = Number(value);
  if (!Number.isSafeInteger(draftId) || draftId <= 0) throw new TypographyServiceError("invalid_draft");
  return draftId;
}

function dictionaryVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new TypographyServiceError("dictionary_version_conflict");
  }
  return version;
}

function selectedIds(value: unknown, allowSafe: boolean): "safe" | string[] {
  if (allowSafe && value === "safe") return "safe";
  if (!Array.isArray(value) || value.length > MAX_SUGGESTIONS) {
    throw new TypographyServiceError("stale_suggestions");
  }
  const ids = value.map((entry) => String(entry));
  if (ids.some((id) => !SUGGESTION_ID.test(id)) || new Set(ids).size !== ids.length) {
    throw new TypographyServiceError("stale_suggestions");
  }
  return ids;
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

function safeSuggestionSnapshot(suggestions: readonly TypographySuggestion[]) {
  return suggestions.map((suggestion) => ({
    id: suggestion.id,
    kind: suggestion.kind,
    start: suggestion.start,
    end: suggestion.end,
    before: suggestion.before,
    after: suggestion.after,
    safe: suggestion.safe,
    explanation: suggestion.explanation,
    rule: suggestion.rule,
    ...(suggestion.dictionaryEntryId == null ? {} : { dictionaryEntryId: suggestion.dictionaryEntryId }),
    ...(suggestion.dictionaryKind == null ? {} : { dictionaryKind: suggestion.dictionaryKind }),
  }));
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistedRunView(row: Record<string, unknown>, duplicate: boolean) {
  return {
    id: Number(row.id),
    sourceText: String(row.source_text),
    resultText: String(row.result_text),
    sourceTextHash: String(row.source_text_hash),
    resultTextHash: String(row.result_text_hash),
    dictionaryVersion: Number(row.dictionary_version),
    rulesVersion: String(row.rules_version),
    suggestions: parseJsonArray(row.suggestions) as TypographySuggestion[],
    acceptedSuggestionIds: parseJsonArray(row.accepted_suggestion_ids).map(String),
    rejectedSuggestionIds: parseJsonArray(row.rejected_suggestion_ids).map(String),
    reviewComplete: row.review_complete === true,
    undone: row.undone_at != null,
    duplicate,
  };
}

export async function applyProjectTypography(input: {
  pool: TransactionPool;
  actorUserId: number;
  requestKey: unknown;
  draftId: unknown;
  text: unknown;
  expectedDictionaryVersion: unknown;
  acceptedSuggestionIds: unknown;
  rejectedSuggestionIds?: unknown;
  formatQuotes?: unknown;
  requestId?: string | null;
}) {
  const requestKey = normalizeRequestKey(input.requestKey);
  const draftId = optionalDraftId(input.draftId);
  const text = normalizeText(input.text);
  const expectedDictionaryVersion = dictionaryVersion(input.expectedDictionaryVersion);
  const acceptedInput = selectedIds(input.acceptedSuggestionIds, true);
  const rejectedInput = selectedIds(input.rejectedSuggestionIds ?? [], false) as string[];
  if (typeof input.formatQuotes !== "boolean" && input.formatQuotes != null) {
    throw new TypographyServiceError("stale_suggestions");
  }
  const formatQuotes = input.formatQuotes === true;
  const sourceTextHash = textHash(text);
  const requestHash = typographyRequestHash({
    draftId,
    sourceTextHash,
    dictionaryVersion: expectedDictionaryVersion,
    acceptedSuggestionIds: acceptedInput,
    rejectedSuggestionIds: rejectedInput,
    formatQuotes,
  });

  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "content.edit");
    const replay = (await client.query(
      `select id, source_text, result_text, source_text_hash, result_text_hash,
              dictionary_version, rules_version, request_hash, suggestions,
              accepted_suggestion_ids, rejected_suggestion_ids,
              review_complete, undone_at
         from project_typography_runs
        where project_id = $1 and request_key = $2
        for update`,
      [membership.projectId, requestKey],
    )).rows[0] as Record<string, unknown> | undefined;
    if (replay) {
      // Legacy rows predate a complete intent fingerprint. Guessing from their
      // result would conflate "safe", explicit selections and quote mode, so a
      // retry is rejected until the caller uses a fresh idempotency key.
      if (String(replay.request_hash ?? "") !== requestHash) {
        throw new TypographyServiceError("request_conflict");
      }
      return { ...persistedRunView(replay, true), remainingSuggestions: [] as TypographySuggestion[] };
    }

    if (draftId != null) {
      const draft = await client.query(
        `select 1 from drafts where id = $1 and project_id = $2 limit 1`,
        [draftId, membership.projectId],
      );
      if (!draft.rows[0]) throw new TypographyServiceError("invalid_draft");
    }

    const dictionary = await getBrandDictionarySnapshotForProject(client, membership.projectId);
    if (dictionary.version !== expectedDictionaryVersion) {
      throw new TypographyServiceError("dictionary_version_conflict");
    }
    const initialSuggestions = analyzeLegalTypography(text, {
      dictionary: dictionary.entries,
      formatQuotes,
    });
    if (initialSuggestions.length > MAX_SUGGESTIONS) {
      throw new TypographyServiceError("invalid_text");
    }

    let suggestions = initialSuggestions;
    let remainingSuggestions: TypographySuggestion[];
    let resultText: string;
    let acceptedIds: string[];

    if (acceptedInput === "safe") {
      // A deterministic correction can reveal another deterministic correction.
      // Example: «Вообщем» -> «В общем» then «В общем». "Apply safe" therefore
      // means a bounded fixed-point operation, not one pass that leaves the
      // durable review state behind the text visible in the editor.
      const evidence = new Map<string, TypographySuggestion>();
      const accepted = new Set<string>();
      let currentText = text;
      let currentSuggestions = initialSuggestions;
      let converged = false;

      for (let pass = 0; pass < MAX_SAFE_PASSES; pass += 1) {
        for (const suggestion of currentSuggestions) evidence.set(suggestion.id, suggestion);
        if (evidence.size > MAX_SUGGESTIONS) throw new TypographyServiceError("invalid_text");

        const safeIds = currentSuggestions
          .filter((suggestion) => suggestion.safe)
          .map((suggestion) => suggestion.id);
        if (safeIds.length === 0) {
          converged = true;
          break;
        }
        const nextText = applyTypographySuggestions(currentText, currentSuggestions, safeIds);
        if (nextText === currentText) {
          converged = true;
          break;
        }
        safeIds.forEach((id) => accepted.add(id));
        currentText = nextText;
        currentSuggestions = analyzeLegalTypography(currentText, {
          dictionary: dictionary.entries,
          formatQuotes,
        });
      }
      if (!converged) throw new TypographyServiceError("invalid_text");

      resultText = currentText;
      remainingSuggestions = currentSuggestions;
      suggestions = [...evidence.values()];
      acceptedIds = [...accepted];
    } else {
      const knownIds = new Set(initialSuggestions.map((suggestion) => suggestion.id));
      acceptedIds = acceptedInput;
      if (
        acceptedIds.some((id) => !knownIds.has(id))
        || rejectedInput.some((id) => !knownIds.has(id))
      ) throw new TypographyServiceError("stale_suggestions");
      const acceptedSet = new Set(acceptedIds);
      if (rejectedInput.some((id) => acceptedSet.has(id))) {
        throw new TypographyServiceError("selection_conflict");
      }
      resultText = applyTypographySuggestions(text, initialSuggestions, acceptedIds);
      remainingSuggestions = analyzeLegalTypography(resultText, {
        dictionary: dictionary.entries,
        formatQuotes,
      });
    }
    const resultTextHash = textHash(resultText);
    const rejectedSet = new Set(rejectedInput);
    const reviewComplete = remainingSuggestions.length === 0
      || (
        resultText === text
        && suggestions.length > 0
        && suggestions.every((suggestion) => rejectedSet.has(suggestion.id))
      );
    const inserted = (await client.query(
      `insert into project_typography_runs
         (project_id, actor_user_id, draft_id, request_key, request_hash, rules_version,
          dictionary_version, source_text, result_text, source_text_hash, result_text_hash,
          suggestions, accepted_suggestion_ids, rejected_suggestion_ids, review_complete)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12::jsonb, $13::jsonb, $14::jsonb, $15)
       returning id, source_text, result_text, source_text_hash, result_text_hash,
                 dictionary_version, rules_version, suggestions,
                 accepted_suggestion_ids, rejected_suggestion_ids,
                 review_complete, undone_at`,
      [
        membership.projectId,
        input.actorUserId,
        draftId,
        requestKey,
        requestHash,
        TYPOGRAPHY_RULES_VERSION,
        dictionary.version,
        text,
        resultText,
        sourceTextHash,
        resultTextHash,
        JSON.stringify(safeSuggestionSnapshot(suggestions)),
        JSON.stringify(acceptedIds),
        JSON.stringify(rejectedInput),
        reviewComplete,
      ],
    )).rows[0] as Record<string, unknown>;
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id,
          after_version, safe_data, request_id, idempotency_key)
       values ($1, $2, 'typography.run.completed', 'typography_run', $3,
               $4, jsonb_build_object(
                 'dictionary_version', $4::bigint,
                 'suggestion_count', $5::integer,
                 'accepted_count', $6::integer,
                 'rejected_count', $7::integer,
                 'review_complete', $8::boolean,
                 'draft_id', $9::bigint
               ), $10, $11)`,
      [
        membership.projectId,
        input.actorUserId,
        String(inserted.id),
        dictionary.version,
        suggestions.length,
        acceptedIds.length,
        rejectedInput.length,
        reviewComplete,
        draftId,
        input.requestId?.slice(0, 128) ?? null,
        `typography:${requestKey}`,
      ],
    );
    return { ...persistedRunView(inserted, false), remainingSuggestions };
  });
}

export async function undoProjectTypographyRun(input: {
  pool: TransactionPool;
  actorUserId: number;
  runId: unknown;
  currentText: unknown;
  requestId?: string | null;
}) {
  const runId = Number(input.runId);
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new TypographyServiceError("run_not_found");
  const currentText = normalizeText(input.currentText);
  const currentTextHash = textHash(currentText);
  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "content.edit");
    const run = (await client.query<{
      source_text: string;
      source_text_hash: string;
      result_text: string;
      result_text_hash: string;
      dictionary_version: number | string;
      undone_at: Date | string | null;
    }>(
      `select source_text, source_text_hash, result_text, result_text_hash,
              dictionary_version, undone_at
         from project_typography_runs
        where id = $1 and project_id = $2
        for update`,
      [runId, membership.projectId],
    )).rows[0];
    if (!run) throw new TypographyServiceError("run_not_found");
    if (run.source_text_hash === run.result_text_hash) throw new TypographyServiceError("nothing_to_undo");
    if (run.result_text_hash !== currentTextHash || run.result_text !== currentText) {
      throw new TypographyServiceError("current_text_mismatch");
    }
    if (run.undone_at == null) {
      await client.query(
        `update project_typography_runs
            set undone_at = now(), undone_by_user_id = $3
          where id = $1 and project_id = $2 and undone_at is null`,
        [runId, membership.projectId, input.actorUserId],
      );
      await client.query(
        `insert into audit_events
           (project_id, actor_user_id, action, entity_type, entity_id,
            safe_data, request_id)
         values ($1, $2, 'typography.run.undone', 'typography_run', $3,
                 jsonb_build_object('dictionary_version', $4::bigint), $5)`,
        [
          membership.projectId,
          input.actorUserId,
          String(runId),
          Number(run.dictionary_version),
          input.requestId?.slice(0, 128) ?? null,
        ],
      );
    }
    return { runId, text: run.source_text, textHash: run.source_text_hash };
  });
}

/**
 * Restores the durable review/undo state for the exact text currently persisted in
 * a draft. The selected project is resolved on the server; callers cannot use a
 * draft id to inspect another workspace.
 */
export async function getLatestTypographyRunForDraft(input: {
  db: Queryable;
  actorUserId: number;
  draftId: unknown;
}) {
  const draftId = optionalDraftId(input.draftId);
  if (draftId == null) throw new TypographyServiceError("invalid_draft");
  const membership = await requireSelectedProjectPermission(input.db, input.actorUserId, "project.read");
  const draft = (await input.db.query<{ text: string }>(
    `select text
       from drafts
      where id = $1 and project_id = $2
      limit 1`,
    [draftId, membership.projectId],
  )).rows[0];
  if (!draft) throw new TypographyServiceError("invalid_draft");
  const dictionary = await getBrandDictionarySnapshotForProject(input.db, membership.projectId);
  const row = (await input.db.query<Record<string, unknown>>(
    `select id, source_text, result_text, source_text_hash, result_text_hash,
            dictionary_version, rules_version, suggestions,
            accepted_suggestion_ids, rejected_suggestion_ids,
            review_complete, undone_at
       from project_typography_runs
      where project_id = $1 and draft_id = $2
        and result_text = $3 and undone_at is null
      order by created_at desc, id desc
      limit 1`,
    [membership.projectId, draftId, draft.text],
  )).rows[0];
  if (!row) return null;
  const run = persistedRunView(row, true);
  return {
    ...run,
    currentReview: run.reviewComplete
      && run.rulesVersion === TYPOGRAPHY_RULES_VERSION
      && run.dictionaryVersion === dictionary.version,
  };
}

/**
 * Final fail-closed publication guard. A text with remaining suggestions must have
 * an explicit, durable reject-all review for the same bytes, rules and dictionary.
 */
export async function recheckTypographyForPublication(input: {
  db: Queryable;
  projectId: number;
  text: string;
  /** The personal-project owner's publish click is an explicit decision to keep the text. */
  allowPublishAsIs?: boolean;
}): Promise<PublicationTypographySnapshot> {
  const text = normalizeText(input.text);
  const dictionary = await getBrandDictionarySnapshotForProject(input.db, input.projectId);
  const suggestions = analyzeLegalTypography(text, { dictionary: dictionary.entries });
  const hash = textHash(text);
  if (suggestions.length === 0) {
    return {
      rulesVersion: TYPOGRAPHY_RULES_VERSION,
      dictionaryVersion: dictionary.version,
      textHash: hash,
      status: "clean",
      suggestionCount: 0,
      reviewRunId: null,
    };
  }
  const reviewed = (await input.db.query<{ id: number | string }>(
    `select id
       from project_typography_runs
      where project_id = $1
        and rules_version = $2
        and dictionary_version = $3
        and result_text_hash = $4
        and result_text = $5
        and review_complete = true
        and undone_at is null
      order by created_at desc, id desc
      limit 1`,
    [input.projectId, TYPOGRAPHY_RULES_VERSION, dictionary.version, hash, text],
  )).rows[0];
  if (!reviewed) {
    if (input.allowPublishAsIs) {
      return {
        rulesVersion: TYPOGRAPHY_RULES_VERSION,
        dictionaryVersion: dictionary.version,
        textHash: hash,
        status: "published_as_is",
        suggestionCount: suggestions.length,
        reviewRunId: null,
      };
    }
    throw new TypographyPublicationError(dictionary.version, suggestions.length);
  }
  return {
    rulesVersion: TYPOGRAPHY_RULES_VERSION,
    dictionaryVersion: dictionary.version,
    textHash: hash,
    status: "reviewed",
    suggestionCount: suggestions.length,
    reviewRunId: Number(reviewed.id),
  };
}
