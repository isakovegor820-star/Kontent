import { describe, expect, it, vi } from "vitest";

import {
  beginGenerationOperation,
  GenerationArtifactError,
  generationBindingValid,
  generationResultHash,
  resolveGenerationDraft,
} from "./generation-artifacts";

const validation = {
  version: 1 as const,
  status: "passed" as const,
  requiresReview: false,
  blockerCodes: [],
  provenance: {
    validatorVersion: "fact-ledger-v1",
    ledgerHash: "fl1-1234abcd",
    checkedAt: "2026-08-05T10:00:00.000Z",
    coverage: "deterministic+semantic" as const,
    semanticEntailment: "passed" as const,
    rulesRun: ["unsupported_claim"],
    sourceIds: ["source:1"],
  },
};

describe("generation artifact binding", () => {
  it("accepts only the exact result text, receipt hash, and receipt payload", () => {
    const text = "Точный проверенный результат";
    const hash = generationResultHash(text);
    const exact = {
      generationResultId: 91,
      text,
      resultHash: hash,
      receiptHash: hash,
      aiValidation: validation,
      receipt: validation,
    };

    expect(generationBindingValid(exact)).toBe(true);
    expect(generationBindingValid({ ...exact, text: `${text}!` })).toBe(false);
    expect(generationBindingValid({ ...exact, generationResultId: 0 })).toBe(false);
    expect(generationBindingValid({ ...exact, receiptHash: "0".repeat(64) })).toBe(false);
    expect(generationBindingValid({
      ...exact,
      receipt: { ...validation, status: "not_checked", requiresReview: true },
    })).toBe(false);
  });

  it("resolves trusted channel, source version, text, and provenance only from the server row", async () => {
    const text = "Материал по выбранной RSS-теме";
    const hash = generationResultHash(text);
    const query = vi.fn(async () => ({
      rows: [{
        id: "91",
        text,
        result_hash: hash,
        receipt_hash: hash,
        receipt_status: "passed",
        receipt: validation,
        channel_id: "11",
        source_context_id: "44",
        source_context_version: "3",
        input_draft_id: null,
        input_draft_version: null,
        source_ref: { kind: "rss", id: "8", label: "Источник" },
        source_purpose: "source_context",
        source_version: "3",
      }],
    }));

    await expect(resolveGenerationDraft(5, 91, { query } as never)).resolves.toMatchObject({
      id: 91,
      text,
      channelId: 11,
      sourceContextId: 44,
      sourceContextVersion: 3,
      sourceRef: { kind: "rss", id: "8" },
      purpose: "publishable",
    });
    const call = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(call[1]).toEqual([91, 5]);
  });

  it("never reopens a provider operation after an immutable result is pending ACK", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "rollback") return { rows: [], rowCount: null };
      if (sql.includes("select id from channels")) return { rows: [{ id: 11 }], rowCount: 1 };
      if (sql.includes("from generation_operations")) {
        return {
          rows: [{
            id: "71",
            request_fingerprint: "a".repeat(64),
            channel_id: "11",
            source_context_id: null,
            source_context_version: null,
            input_draft_id: null,
            input_draft_version: null,
            status: "pending_ack",
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };

    await expect(beginGenerationOperation({
      userId: 5,
      aiUsageId: 33,
      requestKey: "studio:request-1",
      serverRequestId: "123e4567-e89b-42d3-a456-426614174000",
      requestFingerprint: "a".repeat(64),
      channelId: 11,
      providerEngine: "fake",
      providerModel: "fake-v1",
    }, pool as never)).rejects.toEqual(
      expect.objectContaining<Partial<GenerationArtifactError>>({ code: "generation_result_pending_ack" }),
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status = 'running'"))).toBe(false);
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });
});
