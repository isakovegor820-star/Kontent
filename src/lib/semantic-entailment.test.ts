import { describe, expect, it, vi } from "vitest";
import type { FactLedger } from "./fact-ledger";
import {
  extractSemanticClaims,
  validateFactualOutputWithSemantics,
  type SemanticEntailmentAdapter,
} from "./semantic-entailment";

const checkedAt = () => new Date("2026-08-01T12:00:00.000Z");

function communityLedger(): FactLedger {
  return {
    version: 1,
    policy: "closed_world",
    domain: "general",
    evidence: [{
      id: "brief",
      text: "Сообщество выросло из конференции. Здесь встречаются юристы и руководители.",
      source: "brief",
    }],
    required: [{ id: "origin", label: "выросло из конференции", variants: ["выросло из конференции"] }],
    requiredUrls: [],
    forbiddenPhrases: [],
    forbiddenClaims: [],
    constraints: {},
  };
}

function fakeAdapter(
  decide: (text: string) => "supported" | "unsupported" | "unknown",
): SemanticEntailmentAdapter {
  return {
    id: "fake-nli-v1",
    async check({ claims, evidence }) {
      return {
        verdicts: claims.map((claim) => ({
          claimId: claim.id,
          verdict: decide(claim.text),
          evidenceIds: evidence[0] ? [evidence[0].id] : [],
        })),
      };
    },
  };
}

describe("semantic entailment boundary", () => {
  it("extracts bounded declarative claims and skips questions", () => {
    const claims = extractSemanticClaims("Сообщество выросло из конференции. Почему это важно?\nЗдесь встречаются юристы.");
    expect(claims.map((claim) => claim.text)).toEqual([
      "Сообщество выросло из конференции.",
      "Здесь встречаются юристы.",
    ]);
  });

  it("never marks output green when the production checker is unavailable", async () => {
    const result = await validateFactualOutputWithSemantics(
      "Сообщество выросло из конференции. Здесь встречаются юристы.",
      communityLedger(),
      { now: checkedAt },
    );
    expect(result).toMatchObject({
      status: "not_checked",
      passed: false,
      requiresReview: true,
      provenance: { semanticEntailment: "not_checked", semanticAdapter: "unavailable" },
    });
  });

  it("fails closed when an adapter throws or omits a verdict", async () => {
    const throwing: SemanticEntailmentAdapter = {
      id: "fake-nli-v1",
      check: vi.fn(async () => { throw new Error("secret provider response"); }),
    };
    const thrown = await validateFactualOutputWithSemantics(
      "Сообщество выросло из конференции.",
      communityLedger(),
      { adapter: throwing, now: checkedAt },
    );
    expect(thrown).toMatchObject({ status: "not_checked", requiresReview: true });

    const partial: SemanticEntailmentAdapter = {
      id: "fake-nli-v1",
      check: vi.fn(async () => ({ verdicts: [] })),
    };
    const missing = await validateFactualOutputWithSemantics(
      "Сообщество выросло из конференции.",
      communityLedger(),
      { adapter: partial, now: checkedAt },
    );
    expect(missing).toMatchObject({ status: "not_checked", requiresReview: true });
  });

  it("does not green-light a vacuous empty claim set", async () => {
    const ledger: FactLedger = {
      ...communityLedger(),
      required: [],
      evidence: [{ id: "brief", text: "Кратко", source: "brief" }],
    };
    const result = await validateFactualOutputWithSemantics("Кратко.", ledger, {
      adapter: fakeAdapter(() => "supported"),
      now: checkedAt,
    });
    expect(result).toMatchObject({
      status: "not_checked",
      passed: false,
      requiresReview: true,
    });
  });

  it("blocks a novel unsupported claim that deterministic markers do not cover", async () => {
    const text = "Сообщество выросло из конференции. Участники получают доступ к закрытой базе шаблонов.";
    const result = await validateFactualOutputWithSemantics(text, communityLedger(), {
      adapter: fakeAdapter((claim) => claim.includes("закрытой базе") ? "unsupported" : "supported"),
      now: checkedAt,
    });
    expect(result).toMatchObject({
      status: "blocked",
      passed: false,
      requiresReview: false,
      provenance: { coverage: "deterministic+semantic", semanticEntailment: "blocked" },
    });
    expect(result.violations.map((item) => item.code)).toContain("unsupported_semantic_claim");
  });

  it("passes only when every extracted claim is explicitly supported", async () => {
    const result = await validateFactualOutputWithSemantics(
      "Сообщество выросло из конференции. Здесь встречаются юристы.",
      communityLedger(),
      { adapter: fakeAdapter(() => "supported"), now: checkedAt },
    );
    expect(result).toMatchObject({
      status: "passed",
      passed: true,
      requiresReview: false,
      provenance: { coverage: "deterministic+semantic", semanticEntailment: "passed" },
    });
  });
});
