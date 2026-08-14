import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import { requireSelectedProjectPermission } from "./project-permissions";

export const AUDIENCE_QUESTION_SOURCES = [
  "manual",
  "comment",
  "direct_message",
  "support",
  "sales",
  "search",
  "other",
] as const;

export const AUDIENCE_QUESTION_STATUSES = [
  "new",
  "drafting",
  "planned",
  "answered",
  "dismissed",
] as const;

export type AudienceQuestionSource = (typeof AUDIENCE_QUESTION_SOURCES)[number];
export type AudienceQuestionStatus = (typeof AUDIENCE_QUESTION_STATUSES)[number];
export type AudienceQuestionPriority = 1 | 2 | 3;

export type AudienceQuestionRecord = {
  id: number;
  question: string;
  topic: string | null;
  priority: AudienceQuestionPriority;
  occurrences: number;
  status: AudienceQuestionStatus;
  version: number;
  sourceType: AudienceQuestionSource;
  sourceLabel: string | null;
  sourceUrl: string | null;
  context: string | null;
  answerDraftId: number | null;
  generationRequestKey: string | null;
  draftClientKey: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  answeredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AudienceQuestionStats = {
  waiting: number;
  inProgress: number;
  answered: number;
  dismissed: number;
  repeatedDemand: number;
};

export class AudienceQuestionError extends Error {
  constructor(public readonly code:
    | "invalid_request"
    | "not_found"
    | "version_conflict"
    | "invalid_status"
    | "draft_not_found") {
    super(code);
    this.name = "AudienceQuestionError";
  }
}

type Queryable = Pick<Pool | PoolClient, "query">;
type TransactionPool = Pick<Pool, "connect">;
type QuestionRow = Record<string, unknown>;

const QUESTION_SELECT = `
  select question.id, question.question, question.topic, question.priority,
         question.occurrences, question.status, question.version,
         question.generation_request_key, question.draft_client_key,
         question.answer_draft_id, question.first_seen_at, question.last_seen_at,
         question.answered_at, question.created_at, question.updated_at,
         latest.source_type, latest.source_label, latest.source_url, latest.context
    from audience_questions question
    left join lateral (
      select occurrence.source_type, occurrence.source_label,
             occurrence.source_url, occurrence.context
        from audience_question_occurrences occurrence
       where occurrence.question_id = question.id
         and occurrence.project_id = question.project_id
       order by occurrence.occurred_at desc, occurrence.id desc
       limit 1
    ) latest on true`;

function cleanText(value: unknown, max: number, required = false): string | null {
  if (value == null || value === "") {
    if (required) throw new AudienceQuestionError("invalid_request");
    return null;
  }
  if (typeof value !== "string") throw new AudienceQuestionError("invalid_request");
  const clean = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .trim();
  if ((required && clean.length < 3) || clean.length > max) {
    throw new AudienceQuestionError("invalid_request");
  }
  return clean || null;
}

function positiveInteger(value: unknown, max: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new AudienceQuestionError("invalid_request");
  }
  return number;
}

function safePriority(value: unknown): AudienceQuestionPriority {
  const priority = positiveInteger(value, 3);
  return priority as AudienceQuestionPriority;
}

function safeSource(value: unknown): AudienceQuestionSource {
  if (!AUDIENCE_QUESTION_SOURCES.includes(value as AudienceQuestionSource)) {
    throw new AudienceQuestionError("invalid_request");
  }
  return value as AudienceQuestionSource;
}

function safeStatus(value: unknown): AudienceQuestionStatus {
  if (!AUDIENCE_QUESTION_STATUSES.includes(value as AudienceQuestionStatus)) {
    throw new AudienceQuestionError("invalid_request");
  }
  return value as AudienceQuestionStatus;
}

function safeKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9:_-]{16,128}$/u.test(value)) {
    throw new AudienceQuestionError("invalid_request");
  }
  return value;
}

function safeUrl(value: unknown): string | null {
  const clean = cleanText(value, 2_048);
  if (!clean) return null;
  try {
    const url = new URL(clean);
    if (url.protocol !== "https:") throw new Error("protocol");
    return url.toString();
  } catch {
    throw new AudienceQuestionError("invalid_request");
  }
}

export function normalizeAudienceQuestion(value: unknown): string {
  return cleanText(value, 600, true) as string;
}

export function audienceQuestionFingerprint(question: string): string {
  return createHash("sha256")
    .update(question.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/\s+/gu, " ").trim())
    .digest("hex");
}

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value);
}

function mapQuestion(row: QuestionRow): AudienceQuestionRecord {
  return {
    id: Number(row.id),
    question: String(row.question),
    topic: row.topic == null ? null : String(row.topic),
    priority: Number(row.priority) as AudienceQuestionPriority,
    occurrences: Number(row.occurrences),
    status: String(row.status) as AudienceQuestionStatus,
    version: Number(row.version),
    sourceType: String(row.source_type || "manual") as AudienceQuestionSource,
    sourceLabel: row.source_label == null ? null : String(row.source_label),
    sourceUrl: row.source_url == null ? null : String(row.source_url),
    context: row.context == null ? null : String(row.context),
    answerDraftId: row.answer_draft_id == null ? null : Number(row.answer_draft_id),
    generationRequestKey: row.generation_request_key == null ? null : String(row.generation_request_key),
    draftClientKey: row.draft_client_key == null ? null : String(row.draft_client_key),
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    answeredAt: nullableIso(row.answered_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function selectQuestion(
  db: Queryable,
  projectId: number,
  questionId: number,
  suffix = "",
): Promise<AudienceQuestionRecord | null> {
  const row = (await db.query<QuestionRow>(
    `${QUESTION_SELECT} where question.project_id = $1 and question.id = $2 ${suffix}`,
    [projectId, questionId],
  )).rows[0];
  return row ? mapQuestion(row) : null;
}

export async function listAudienceQuestions(input: {
  actorUserId: number;
  db?: Queryable;
}): Promise<{ questions: AudienceQuestionRecord[]; stats: AudienceQuestionStats }> {
  const db = input.db ?? getPool();
  const membership = await requireSelectedProjectPermission(db, input.actorUserId, "project.read");
  const rows = (await db.query<QuestionRow>(
    `${QUESTION_SELECT}
      where question.project_id = $1
      order by
        case question.status
          when 'new' then 1 when 'drafting' then 2 when 'planned' then 3
          when 'answered' then 4 else 5
        end,
        question.priority desc, question.occurrences desc,
        question.last_seen_at desc, question.id desc
      limit 500`,
    [membership.projectId],
  )).rows.map(mapQuestion);
  const statsRow = (await db.query<{
    waiting: number | string;
    in_progress: number | string;
    answered: number | string;
    dismissed: number | string;
    repeated_demand: number | string;
  }>(
    `select
       count(*) filter (where status = 'new') as waiting,
       count(*) filter (where status in ('drafting','planned')) as in_progress,
       count(*) filter (where status = 'answered') as answered,
       count(*) filter (where status = 'dismissed') as dismissed,
       coalesce(sum(greatest(0, occurrences - 1)), 0) as repeated_demand
     from audience_questions where project_id = $1`,
    [membership.projectId],
  )).rows[0];
  return {
    questions: rows,
    stats: {
      waiting: Number(statsRow?.waiting ?? 0),
      inProgress: Number(statsRow?.in_progress ?? 0),
      answered: Number(statsRow?.answered ?? 0),
      dismissed: Number(statsRow?.dismissed ?? 0),
      repeatedDemand: Number(statsRow?.repeated_demand ?? 0),
    },
  };
}

export async function getAudienceQuestion(input: {
  actorUserId: number;
  questionId: number;
  db?: Queryable;
}): Promise<AudienceQuestionRecord> {
  const db = input.db ?? getPool();
  const membership = await requireSelectedProjectPermission(db, input.actorUserId, "project.read");
  const question = await selectQuestion(db, membership.projectId, positiveInteger(input.questionId, Number.MAX_SAFE_INTEGER));
  if (!question) throw new AudienceQuestionError("not_found");
  return question;
}

export async function createAudienceQuestion(input: {
  actorUserId: number;
  requestKey: unknown;
  question: unknown;
  topic?: unknown;
  priority?: unknown;
  occurrences?: unknown;
  sourceType?: unknown;
  sourceLabel?: unknown;
  sourceUrl?: unknown;
  context?: unknown;
  pool?: TransactionPool;
}): Promise<{ question: AudienceQuestionRecord; duplicate: boolean }> {
  const requestKey = safeKey(input.requestKey);
  const questionText = normalizeAudienceQuestion(input.question);
  const fingerprint = audienceQuestionFingerprint(questionText);
  const topic = cleanText(input.topic, 160);
  const priority = safePriority(input.priority ?? 2);
  const occurrences = positiveInteger(input.occurrences ?? 1, 10_000);
  const sourceType = safeSource(input.sourceType ?? "manual");
  const sourceLabel = cleanText(input.sourceLabel, 200);
  const sourceUrl = safeUrl(input.sourceUrl);
  const context = cleanText(input.context, 2_000);
  const pool = input.pool ?? getPool();
  const db = await pool.connect();
  try {
    await db.query("begin");
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.create");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `audience-question:${membership.projectId}:${requestKey}`,
    ]);
    const replay = (await db.query<{ question_id: number | string }>(
      `select question_id from audience_question_occurrences
        where project_id = $1 and request_key = $2 limit 1`,
      [membership.projectId, requestKey],
    )).rows[0];
    if (replay) {
      const existing = await selectQuestion(db, membership.projectId, Number(replay.question_id));
      if (!existing) throw new AudienceQuestionError("not_found");
      await db.query("commit");
      return { question: existing, duplicate: true };
    }

    const aggregate = (await db.query<{ id: number | string; inserted: boolean }>(
      `insert into audience_questions (
         project_id, created_by_user_id, question, question_fingerprint,
         topic, priority, occurrences
       ) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (project_id, question_fingerprint) do update set
         topic = coalesce(audience_questions.topic, excluded.topic),
         priority = greatest(audience_questions.priority, excluded.priority),
         occurrences = least(1000000, audience_questions.occurrences + excluded.occurrences),
         status = case when audience_questions.status in ('answered','dismissed') then 'new' else audience_questions.status end,
         generation_request_key = case when audience_questions.status in ('answered','dismissed') then null else audience_questions.generation_request_key end,
         draft_client_key = case when audience_questions.status in ('answered','dismissed') then null else audience_questions.draft_client_key end,
         answer_draft_id = case when audience_questions.status in ('answered','dismissed') then null else audience_questions.answer_draft_id end,
         answered_at = null,
         last_seen_at = now(), updated_at = now(), version = audience_questions.version + 1
       returning id, (xmax = 0) as inserted`,
      [membership.projectId, input.actorUserId, questionText, fingerprint, topic, priority, occurrences],
    )).rows[0];

    await db.query(
      `insert into audience_question_occurrences (
         project_id, question_id, submitted_by_user_id, request_key,
         source_type, source_label, source_url, context, occurrence_count
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [membership.projectId, aggregate.id, input.actorUserId, requestKey,
        sourceType, sourceLabel, sourceUrl, context, occurrences],
    );
    const created = await selectQuestion(db, membership.projectId, Number(aggregate.id));
    if (!created) throw new AudienceQuestionError("not_found");
    await db.query("commit");
    return { question: created, duplicate: aggregate.inserted !== true };
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

export async function updateAudienceQuestion(input: {
  actorUserId: number;
  questionId: number;
  expectedVersion: unknown;
  status?: unknown;
  priority?: unknown;
  topic?: unknown;
  answerDraftId?: unknown;
  pool?: TransactionPool;
}): Promise<AudienceQuestionRecord> {
  const questionId = positiveInteger(input.questionId, Number.MAX_SAFE_INTEGER);
  const expectedVersion = positiveInteger(input.expectedVersion, Number.MAX_SAFE_INTEGER);
  const pool = input.pool ?? getPool();
  const db = await pool.connect();
  try {
    await db.query("begin");
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.edit");
    const current = await selectQuestion(db, membership.projectId, questionId, "for update of question");
    if (!current) throw new AudienceQuestionError("not_found");
    if (current.version !== expectedVersion) throw new AudienceQuestionError("version_conflict");

    const nextStatus = input.status == null ? current.status : safeStatus(input.status);
    const nextPriority = input.priority == null ? current.priority : safePriority(input.priority);
    const nextTopic = input.topic === undefined ? current.topic : cleanText(input.topic, 160);
    let answerDraftId = input.answerDraftId === undefined
      ? current.answerDraftId
      : input.answerDraftId == null
        ? null
        : positiveInteger(input.answerDraftId, Number.MAX_SAFE_INTEGER);
    if (answerDraftId != null) {
      const owned = (await db.query(
        "select 1 from drafts where id = $1 and project_id = $2 limit 1",
        [answerDraftId, membership.projectId],
      )).rowCount === 1;
      if (!owned) throw new AudienceQuestionError("draft_not_found");
    }
    if (nextStatus === "planned" && answerDraftId == null) {
      throw new AudienceQuestionError("draft_not_found");
    }
    const reopen = nextStatus === "new";
    if (reopen) answerDraftId = null;
    await db.query(
      `update audience_questions set
         status = $3, priority = $4, topic = $5, answer_draft_id = $6,
         generation_request_key = case when $7 then null else generation_request_key end,
         draft_client_key = case when $7 then null else draft_client_key end,
         answered_at = case when $3 = 'answered' then now() else null end,
         version = version + 1, updated_at = now()
       where id = $1 and project_id = $2 and version = $8`,
      [questionId, membership.projectId, nextStatus, nextPriority, nextTopic,
        answerDraftId, reopen, expectedVersion],
    );
    const updated = await selectQuestion(db, membership.projectId, questionId);
    if (!updated) throw new AudienceQuestionError("not_found");
    await db.query("commit");
    return updated;
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

export async function startAudienceQuestionDraft(input: {
  actorUserId: number;
  questionId: number;
  expectedVersion: unknown;
  pool?: TransactionPool;
}): Promise<AudienceQuestionRecord> {
  const questionId = positiveInteger(input.questionId, Number.MAX_SAFE_INTEGER);
  const expectedVersion = positiveInteger(input.expectedVersion, Number.MAX_SAFE_INTEGER);
  const pool = input.pool ?? getPool();
  const db = await pool.connect();
  try {
    await db.query("begin");
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.create");
    const current = await selectQuestion(db, membership.projectId, questionId, "for update of question");
    if (!current) throw new AudienceQuestionError("not_found");
    if (current.status === "drafting" && current.generationRequestKey && current.draftClientKey) {
      await db.query("commit");
      return current;
    }
    if (current.version !== expectedVersion) throw new AudienceQuestionError("version_conflict");
    if (current.status !== "new") throw new AudienceQuestionError("invalid_status");
    const generationRequestKey = randomUUID();
    const draftClientKey = `audience-question:${questionId}:${randomUUID()}`;
    await db.query(
      `update audience_questions set
         status = 'drafting', generation_request_key = $3, draft_client_key = $4,
         version = version + 1, updated_at = now()
       where id = $1 and project_id = $2 and version = $5`,
      [questionId, membership.projectId, generationRequestKey, draftClientKey, expectedVersion],
    );
    const updated = await selectQuestion(db, membership.projectId, questionId);
    if (!updated) throw new AudienceQuestionError("not_found");
    await db.query("commit");
    return updated;
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

export async function linkAudienceQuestionDraft(input: {
  actorUserId: number;
  questionId: number;
  generationRequestKey: unknown;
  answerDraftId: unknown;
  pool?: TransactionPool;
}): Promise<AudienceQuestionRecord> {
  const questionId = positiveInteger(input.questionId, Number.MAX_SAFE_INTEGER);
  const generationRequestKey = safeKey(input.generationRequestKey);
  const answerDraftId = positiveInteger(input.answerDraftId, Number.MAX_SAFE_INTEGER);
  const pool = input.pool ?? getPool();
  const db = await pool.connect();
  try {
    await db.query("begin");
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.edit");
    const current = await selectQuestion(db, membership.projectId, questionId, "for update of question");
    if (!current) throw new AudienceQuestionError("not_found");
    if (current.status === "planned" && current.answerDraftId === answerDraftId) {
      await db.query("commit");
      return current;
    }
    if (
      current.status !== "drafting"
      || current.generationRequestKey !== generationRequestKey
    ) throw new AudienceQuestionError("invalid_status");
    const owned = (await db.query(
      "select 1 from drafts where id = $1 and project_id = $2 limit 1",
      [answerDraftId, membership.projectId],
    )).rowCount === 1;
    if (!owned) throw new AudienceQuestionError("draft_not_found");
    await db.query(
      `update audience_questions set
         status = 'planned', answer_draft_id = $3,
         version = version + 1, updated_at = now()
       where id = $1 and project_id = $2`,
      [questionId, membership.projectId, answerDraftId],
    );
    const updated = await selectQuestion(db, membership.projectId, questionId);
    if (!updated) throw new AudienceQuestionError("not_found");
    await db.query("commit");
    return updated;
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

export function buildAudienceQuestionPrompt(question: AudienceQuestionRecord): string {
  const details = [
    `Вопрос аудитории: «${question.question}»`,
    question.topic ? `Тема: ${question.topic}` : null,
    question.context ? `Контекст вопроса: ${question.context}` : null,
    question.occurrences > 1 ? `Число зафиксированных обращений с этим вопросом: ${question.occurrences}.` : null,
  ].filter(Boolean).join("\n");
  return [
    "Создай оригинальный пост, который прямо и понятно отвечает на реальный вопрос аудитории.",
    details,
    "Сохрани вопрос как читательскую задачу и не заменяй его другой темой.",
    "Не считай сам вопрос подтверждением фактов. Не придумывай цифры, даты, имена, нормы или ссылки; используй только подтверждённые данные канала. Если данных недостаточно, честно дай полезное объяснение без новой конкретики.",
    "Начни с короткого прямого ответа, затем объясни логику и закончи практическим следующим шагом.",
  ].join("\n\n");
}
