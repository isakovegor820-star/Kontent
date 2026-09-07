const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;

// Read-only facts for the original decision POST. Even a complete receipt does
// not certify that the browser consumed its response, or permit a retry.
export async function readEditorialReceiptDiagnostics(pool, diagnostics) {
  const candidates = diagnostics.filter(row => row.method === "POST"
    && /^\/api\/drafts\/[1-9]\d*\/editorial\/decisions$/u.test(row.path) && row.editorialAck);
  const facts = [];
  for (const row of candidates.slice(0, 128)) {
    const ack = row.editorialAck;
    const draftId = positive(row.path.split("/")[3]);
    const projectId = positive(ack.projectId);
    const reviewRequestId = positive(ack.request?.reviewRequestId);
    const fact = { requestId: row.id, draftId, projectId, reviewRequestId, ledger: null };
    facts.push(fact);
    if (!draftId || !projectId || !reviewRequestId) { fact.unavailable = "incomplete_request_identity"; continue; }
    if (!pool) { fact.unavailable = "database_unavailable"; continue; }
    const result = await pool.query({
      text: `select decision.id, decision.project_id, decision.request_id, decision.draft_id,
                    decision.revision_id, decision.content_hash, decision.actor_user_id, decision.decision,
                    request.version as request_version, request.status as request_status,
                    request.resolved_by_user_id,
                    revision.content_hash as revision_content_hash,
                    workflow.version as current_workflow_version, workflow.state as current_workflow_state,
                    workflow.current_revision_id, workflow.approved_revision_id, workflow.approved_content_hash
               from draft_editorial_decisions decision
               join draft_editorial_requests request on request.id = decision.request_id
                 and request.project_id = decision.project_id and request.draft_id = decision.draft_id
               join draft_revisions revision on revision.id = decision.revision_id
                 and revision.project_id = decision.project_id and revision.draft_id = decision.draft_id
               left join draft_editorial_workflows workflow on workflow.project_id = decision.project_id
                 and workflow.draft_id = decision.draft_id
              where decision.project_id = $1 and decision.draft_id = $2 and decision.request_id = $3
              limit 2`,
      values: [projectId, draftId, reviewRequestId], query_timeout: 5_000,
    });
    fact.rowCount = result.rows.length;
    if (result.rows.length !== 1) continue;
    const value = result.rows[0];
    fact.ledger = {
      decisionId: positive(value.id), projectId: positive(value.project_id), draftId: positive(value.draft_id),
      reviewRequestId: positive(value.request_id), revisionId: positive(value.revision_id),
      contentHash: hash(value.content_hash), actorUserId: positive(value.actor_user_id),
      decision: ["approve", "request_changes"].includes(value.decision) ? value.decision : null,
      requestVersion: positive(value.request_version),
      requestStatus: ["open", "approved", "changes_requested", "superseded"].includes(value.request_status) ? value.request_status : null,
      resolvedByUserId: positive(value.resolved_by_user_id), revisionContentHash: hash(value.revision_content_hash),
      // These mutable fields describe the time of finalization, not the earlier ACK.
      currentWorkflowVersion: positive(value.current_workflow_version),
      currentWorkflowState: ["draft", "in_review", "approved", "changes_requested"].includes(value.current_workflow_state) ? value.current_workflow_state : null,
      currentRevisionId: positive(value.current_revision_id), approvedRevisionId: positive(value.approved_revision_id),
      approvedContentHash: hash(value.approved_content_hash),
    };
  }
  return { diagnosticOnly: true, candidateCount: candidates.length, omittedCount: Math.max(0, candidates.length - 128), facts };
}
