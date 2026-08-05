import { describe, expect, it } from "vitest";
import {
  annotateAutopilotItems,
  autopilotPlanRevisionHash,
  buildAutopilotApprovalPreview,
  evaluateAutopilotItem,
  executeAutopilotApproval,
} from "./autopilot-approval.mjs";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const passedQuality = {
  score: 91,
  threshold: 85,
  passed: true,
  blockers: [],
  violations: [],
  semantic: {
    version: 1,
    status: "passed",
    passed: true,
    requiresReview: false,
    blockers: [],
    claimVerdicts: [{
      claimId: "claim-1", claim: "Проверенный текст", verdict: "supported",
      reasonCode: "entailed_by_source", riskCodes: [],
      sourceSpans: [{ sourceId: "qa-source", start: 0, end: 20 }],
    }],
    provenance: {
      validatorVersion: "semantic-publication-v1",
      checkedAt: "2026-08-02T09:30:00.000Z",
      provider: "qa-nli-v1",
      model: "qa-entailment-v1",
      sourceIds: ["qa-source"],
      rejectedSourceSpans: [],
      terminalVerdict: "passed",
    },
  },
  metadata: {
    checkedAt: "2026-08-01T11:55:00.000Z",
    rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
    provenance: {
      kind: "deterministic",
      validator: "validatePostQuality",
      trigger: "generation",
      humanAttestation: null,
    },
  },
};

const item = (overrides = {}) => ({
  i: 0,
  scheduledAt: "2026-08-01T13:00:00.000Z",
  topic: "Тема",
  draft: "Проверенный текст",
  status: "pending",
  quality: passedQuality,
  ...overrides,
});

describe("Autopilot approval policy", () => {
  it("makes three expired items ineligible and marks immutable copies expired", () => {
    const source = [
      item({ i: 0, scheduledAt: "2026-08-01T11:00:00.000Z" }),
      item({ i: 1, scheduledAt: "2026-08-01T11:30:00.000Z" }),
      item({ i: 2, scheduledAt: "2026-08-01T12:00:30.000Z" }),
    ];

    const preview = buildAutopilotApprovalPreview({
      items: source,
      nowMs: NOW,
      channel: { id: 7, title: "Канал" },
      planId: 9,
    });
    const annotated = annotateAutopilotItems(source, NOW);

    expect(preview.counts).toEqual({ total: 3, eligible: 0, expired: 3, blocked: 0 });
    expect(preview.dates).toEqual([]);
    expect(annotated.every((entry) => entry.status === "expired")).toBe(true);
    expect(source.every((entry) => entry.status === "pending")).toBe(true);
  });

  it("blocks a missing or incomplete quality result server-side", () => {
    expect(evaluateAutopilotItem(item({ quality: undefined }), NOW).blockers).toContainEqual(
      expect.objectContaining({ code: "quality_missing" }),
    );
    expect(evaluateAutopilotItem(item({ quality: { passed: true } }), NOW).eligible).toBe(false);
    const legacyResult = { ...passedQuality };
    delete legacyResult.metadata;
    expect(evaluateAutopilotItem(item({ quality: legacyResult }), NOW).blockers).toContainEqual(
      expect.objectContaining({ code: "quality_missing" }),
    );
  });

  it("blocks failed quality and empty drafts", () => {
    const result = evaluateAutopilotItem(
      item({
        draft: "  ",
        quality: {
          ...passedQuality,
          passed: false,
          blockers: ["Неподтверждённый факт"],
        },
      }),
      NOW,
    );
    expect(result.blockers.map((entry) => entry.code)).toEqual(["empty_draft", "quality_failed"]);
  });

  it("exposes the channel, exact eligible dates, counts, and blocker reasons", () => {
    const preview = buildAutopilotApprovalPreview({
      items: [
        item(),
        item({ i: 1, scheduledAt: "2026-08-01T10:00:00.000Z" }),
        item({ i: 2, quality: undefined }),
        item({ i: 3, status: "approved", postId: 42 }),
      ],
      nowMs: NOW,
      channel: { id: 7, title: "Технологии", handle: "tech" },
      planId: 9,
    });

    expect(preview.channel).toEqual({ id: 7, title: "Технологии", handle: "tech" });
    expect(preview).toMatchObject({ revision: 1, hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(preview.items[0]).toMatchObject({ i: 0, draft: "Проверенный текст" });
    expect(preview.counts).toEqual({ total: 3, eligible: 1, expired: 1, blocked: 1 });
    expect(preview.dates).toEqual([{ index: 0, scheduledAt: "2026-08-01T13:00:00.000Z" }]);
    expect(preview.blockers.map((entry) => entry.reasons[0].code)).toEqual([
      "expired",
      "quality_missing",
    ]);
  });

  it("binds the canonical revision hash to channel, text, date and quality", () => {
    const base = { items: [item()], planId: 9, planRevision: 4, channelId: 7 };
    const hash = autopilotPlanRevisionHash(base);
    expect(autopilotPlanRevisionHash({ ...base, items: [item({ draft: "Другой текст" })] })).not.toBe(hash);
    expect(autopilotPlanRevisionHash({ ...base, items: [item({ scheduledAt: "2026-08-01T14:00:00Z" })] })).not.toBe(hash);
    expect(autopilotPlanRevisionHash({ ...base, items: [item({ quality: { ...passedQuality, passed: false } })] })).not.toBe(hash);
    expect(autopilotPlanRevisionHash({ ...base, channelId: 8 })).not.toBe(hash);
    expect(autopilotPlanRevisionHash({ ...base, planRevision: 5 })).not.toBe(hash);
  });

  it("creates no posts for expired items", async () => {
    let calls = 0;
    const result = await executeAutopilotApproval({
      items: [0, 1, 2].map((i) => item({ i, scheduledAt: "2026-08-01T11:00:00.000Z" })),
      nowMs: NOW,
      schedule: async () => {
        calls += 1;
        return calls;
      },
    });

    expect(calls).toBe(0);
    expect(result.scheduled).toBe(0);
    expect(result.items.every((entry) => entry.status === "expired")).toBe(true);
  });

  it("checkpoints a partial queue failure and retries only untouched items", async () => {
    const attempts = [];
    const checkpoints = [];
    const first = await executeAutopilotApproval({
      items: [0, 1, 2].map((i) => item({ i })),
      nowMs: NOW,
      schedule: async (entry) => {
        attempts.push(entry.i);
        if (entry.i === 1) throw new Error("queue unavailable");
        return entry.i + 100;
      },
      onCheckpoint: async (entries) => checkpoints.push(structuredClone(entries)),
    });

    expect(first.scheduled).toBe(1);
    expect(first.error).toBeInstanceOf(Error);
    expect(checkpoints).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ status: "approved", postId: 100 });
    expect(first.items[1]).toMatchObject({ status: "pending" });

    const retry = await executeAutopilotApproval({
      items: first.items,
      nowMs: NOW,
      schedule: async (entry) => {
        attempts.push(entry.i);
        return entry.i + 100;
      },
    });
    expect(retry.error).toBeNull();
    expect(retry.scheduled).toBe(2);
    expect(attempts).toEqual([0, 1, 1, 2]);
    expect(retry.items.map((entry) => entry.postId)).toEqual([100, 101, 102]);
  });
});
