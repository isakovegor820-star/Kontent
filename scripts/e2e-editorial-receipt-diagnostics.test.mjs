import { expect, it, vi } from "vitest";
import { readEditorialReceiptDiagnostics } from "./e2e-editorial-receipt-diagnostics.mjs";

const contentHash = "a".repeat(64);
const request = () => ({ id: 74, method: "POST", path: "/api/drafts/2/editorial/decisions",
  editorialAck: { projectId: 3, request: { reviewRequestId: 4 }, receipt: null } });
const row = () => ({ id: "5", project_id: "3", request_id: "4", draft_id: "2", revision_id: "6",
  content_hash: contentHash, actor_user_id: "7", decision: "approve", request_version: "2",
  request_status: "approved", resolved_by_user_id: "7", revision_content_hash: contentHash,
  current_workflow_version: "12", current_workflow_state: "draft", current_revision_id: "8",
  approved_revision_id: null, approved_content_hash: null });

it("retains an immutable ledger fact even when the original POST has no complete ACK", async () => {
  const query = vi.fn(async () => ({ rows: [row()] }));
  const result = await readEditorialReceiptDiagnostics({ query }, [request()]);
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0][0]).toMatchObject({ values: [3, 2, 4], query_timeout: 5_000 });
  expect(query.mock.calls[0][0].text.trim()).toMatch(/^select /u);
  expect(query.mock.calls[0][0].text).not.toMatch(/\b(?:insert|update|delete|snapshot|note|body)\b/iu);
  expect(result).toMatchObject({ diagnosticOnly: true, candidateCount: 1, omittedCount: 0,
    facts: [{ requestId: 74, rowCount: 1, ledger: { decisionId: 5, actorUserId: 7,
      revisionId: 6, contentHash, currentWorkflowVersion: 12, currentWorkflowState: "draft" } }] });
  expect(JSON.stringify(result)).not.toMatch(/\b(?:proved|verified|successful|retry|cancellation)\b/u);
});
it.each([0, 2])("missing or ambiguous ledger rows (%s) remain unavailable", async count => {
  const result = await readEditorialReceiptDiagnostics({ query: async () => ({ rows: Array.from({ length: count }, row) }) }, [request()]);
  expect(result.facts[0]).toMatchObject({ rowCount: count, ledger: null });
});
it.each(["GET", "PUT", "PATCH"])("ignores %s mutations and reads", async method => {
  const query = vi.fn();
  expect((await readEditorialReceiptDiagnostics({ query }, [{ ...request(), method }])).facts).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});
it("does not query an incomplete or injected request identity", async () => {
  const query = vi.fn(); const input = request(); input.editorialAck.projectId = "3; delete from users";
  const result = await readEditorialReceiptDiagnostics({ query }, [input]);
  expect(result.facts[0]).toMatchObject({ unavailable: "incomplete_request_identity", ledger: null });
  expect(query).not.toHaveBeenCalled();
});
it("never emits extra DB columns or arbitrary strings", async () => {
  const result = await readEditorialReceiptDiagnostics({ query: async () => ({ rows: [{ ...row(),
    note: "SENSITIVE_NOTE", snapshot: { text: "PRIVATE_DRAFT" }, request_status: "UNTRUSTED_STATUS",
    decision: "SENSITIVE_DECISION", content_hash: "SENSITIVE_HASH" }] }) }, [request()]);
  expect(JSON.stringify(result)).not.toMatch(/SENSITIVE|PRIVATE|UNTRUSTED/u);
  expect(result.facts[0].ledger).toMatchObject({ contentHash: null, requestStatus: null, decision: null });
});
it("bounds diagnostic queries and records omitted rows", async () => {
  const query = vi.fn(async () => ({ rows: [] }));
  const result = await readEditorialReceiptDiagnostics({ query }, Array.from({ length: 129 }, request));
  expect(query).toHaveBeenCalledTimes(128); expect(result.omittedCount).toBe(1);
});
it("keeps missing database explicit without starting a connection", async () => {
  const result = await readEditorialReceiptDiagnostics(null, [request()]);
  expect(result.facts[0].unavailable).toBe("database_unavailable");
});
