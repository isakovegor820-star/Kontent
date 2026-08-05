import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
type AnswerRow = {
  run_revision: string | number;
  question_id: string;
  status: string;
  confidence: string;
  short_answer: string;
  evidence_keys: unknown;
};

function fingerprint(row: AnswerRow) {
  return JSON.stringify({
    status: row.status,
    confidence: row.confidence,
    shortAnswer: row.short_answer,
    evidenceKeys: row.evidence_keys,
  });
}
export async function GET(req: NextRequest, context: Context) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized", requestId }, { status: 401, headers: { "x-request-id": requestId } });
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "bad_id", requestId }, { status: 400, headers: { "x-request-id": requestId } });
  try {
    const pool = getPool();
    const owned = await pool.query<{ run_revision: string | number; request_id: string }>(
      `select run_revision, request_id from site_analysis_jobs where id = $1 and user_id = $2`,
      [id, user.id],
    );
    const currentRevision = Number(owned.rows[0]?.run_revision || 0);
    if (!currentRevision) return NextResponse.json({ error: "not_found", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    const rows = await pool.query<AnswerRow>(
      `select run_revision, question_id, status, confidence, short_answer, evidence_keys
         from site_analysis_answers
        where analysis_id = $1 and run_revision <= $2
        order by run_revision desc, question_id`,
      [id, currentRevision],
    );
    const revisions = [...new Set(rows.rows.map((row) => Number(row.run_revision)))].sort((left, right) => right - left);
    const previousRevision = revisions.find((revision) => revision < currentRevision) || null;
    if (!previousRevision) {
      return NextResponse.json({
        ok: true,
        requestId: owned.rows[0].request_id,
        comparison: { currentRevision, previousRevision: null, new: [], changed: [], disappeared: [], unchanged: 0 },
      }, { headers: { "x-request-id": owned.rows[0].request_id, "cache-control": "no-store" } });
    }
    const current = new Map(rows.rows.filter((row) => Number(row.run_revision) === currentRevision).map((row) => [row.question_id, row]));
    const previous = new Map(rows.rows.filter((row) => Number(row.run_revision) === previousRevision).map((row) => [row.question_id, row]));
    const added = [...current.keys()].filter((questionId) => !previous.has(questionId));
    const disappeared = [...previous.keys()].filter((questionId) => !current.has(questionId));
    const changed = [...current.keys()].filter((questionId) => previous.has(questionId) && fingerprint(current.get(questionId)!) !== fingerprint(previous.get(questionId)!));
    const unchanged = [...current.keys()].filter((questionId) => previous.has(questionId) && !changed.includes(questionId)).length;
    return NextResponse.json({
      ok: true,
      requestId: owned.rows[0].request_id,
      comparison: { currentRevision, previousRevision, new: added, changed, disappeared, unchanged },
    }, { headers: { "x-request-id": owned.rows[0].request_id, "cache-control": "no-store" } });
  } catch (error) {
    console.error("[/api/site-analysis/:id/compare] GET", { requestId, analysisId: id, errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "unavailable", requestId }, { status: 503, headers: { "x-request-id": requestId } });
  }
}
