import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  QUALITY_FAILURE_GUIDE,
  autopilotQualityFailureReport,
} from "./autopilot-quality-report.mjs";
import { SEMANTIC_RISK_RULES, validateSemanticClaims } from "./semantic-claims.mjs";
import { buildQualityPrompt, buildRewritePrompt, presetQuality } from "./post-quality.mjs";

const sourceOf = (name) => readFile(new URL(name, import.meta.url), "utf8");

describe("Autopilot quality failure diagnosis", () => {
  // Месяц «модель не дотянула до порога» стоил ровно этого: причина лежала в плане, но
  // у кода нарушения не было человеческого объяснения, и совет был неверным. Тест держит
  // словарь полным — новый гейт нельзя завести, не сказав человеку, что с ним делать.
  it("explains every blocker code the quality gate can produce", async () => {
    const deterministic = [...(await sourceOf("./post-quality.mjs")).matchAll(
      /addViolation\(\s*violations,\s*"([a-z_]+)"/gu,
    )].map((match) => match[1]);
    const semantic = [...(await sourceOf("./autopilot-quality.mjs")).matchAll(
      /code:\s*"([a-z_]+)"/gu,
    )].map((match) => match[1]);
    const semanticBlockers = [...(await sourceOf("./semantic-claims.mjs")).matchAll(
      /code:\s*"([a-z_]+)"/gu,
    )].map((match) => match[1]);
    const codes = [...new Set([...deterministic, ...semantic, ...semanticBlockers])];

    expect(codes.length).toBeGreaterThanOrEqual(24);
    expect(codes.filter((code) => !QUALITY_FAILURE_GUIDE[code])).toEqual([]);
    for (const entry of Object.values(QUALITY_FAILURE_GUIDE)) {
      expect(entry.title.length).toBeGreaterThan(8);
      expect(entry.action.length).toBeGreaterThan(16);
      expect(["knowledge", "settings", "retry", "review"]).toContain(entry.fix);
      expect(["ready", "confirmation_required", "blocked"]).toContain(entry.publicationDisposition);
      expect([
        "deterministic_format",
        "rewrite",
        "add_knowledge",
        "human_review",
        "provider_retry",
        "settings_change",
      ]).toContain(entry.repairStrategy);
    }
  });

  it("counts posts rather than violations and names the dominant fix", () => {
    const report = autopilotQualityFailureReport([
      {
        aiReady: true,
        draft: "готовый пост",
        quality: {
          passed: false,
          violations: [
            { code: "no_sources", blocker: true },
            { code: "no_sources", blocker: true },
            { code: "punctuation", blocker: false },
          ],
        },
      },
      {
        aiReady: true,
        draft: "второй пост",
        quality: { passed: false, violations: [{ code: "no_sources", blocker: true }] },
      },
      {
        aiReady: true,
        draft: "третий пост",
        quality: { passed: true, violations: [{ code: "bold", blocker: false }] },
      },
    ]);

    expect(report).toMatchObject({ total: 3, passed: 1, failed: 2, drafts: 3, primaryFix: "add_knowledge" });
    expect(report.causes).toHaveLength(1);
    expect(report.causes[0]).toMatchObject({ code: "no_sources", count: 2, fix: "knowledge" });
  });

  it("reports a missing draft as a provider failure, not as an unnamed reason", () => {
    const report = autopilotQualityFailureReport([{ aiReady: false, draft: "" }], 2);
    expect(report).toMatchObject({ total: 2, passed: 0, failed: 2, drafts: 0 });
    expect(report.causes[0].code).toBe("empty");
  });

  it("does not diagnose hook and structure defects when the provider returned no text", () => {
    const report = autopilotQualityFailureReport([{
      aiReady: false,
      draft: "",
      buildState: "waiting_provider",
      quality: {
        passed: false,
        violations: [
          { code: "empty", blocker: true },
          { code: "hook", blocker: true },
          { code: "structure", blocker: true },
        ],
      },
    }], 7);

    expect(report.causes).toEqual([
      expect.objectContaining({ code: "empty", count: 1, repairStrategy: "provider_retry" }),
    ]);
  });
});

describe("Generation prompt agrees with the semantic gate", () => {
  // Правило, которое живёт только в проверке, — это ловушка: модель не знает о запрете,
  // пишет «снижает риск» в каждом посте, и план заворачивается целиком.
  it("carries every risk rule into the generation prompt", () => {
    const prompt = buildQualityPrompt(presetQuality("legal"), { postIndex: 0 });
    for (const rule of SEMANTIC_RISK_RULES) expect(prompt).toContain(rule);
  });

  it("tells the model to delete an unsupported claim instead of rephrasing it", () => {
    const rewrite = buildRewritePrompt("черновик", {
      violations: [{ code: "unsupported_semantic_claim", message: "Утверждение не подтверждено" }],
    });
    expect(rewrite).toContain("Оценочные утверждения не перефразируй");
    for (const rule of SEMANTIC_RISK_RULES) expect(rewrite).toContain(rule);
    expect(buildRewritePrompt("черновик", { violations: [{ code: "too_short", message: "коротко" }] }))
      .not.toContain("Оценочные утверждения не перефразируй");
  });

  // JS \b не понимает кириллицу: шаблон вида /\bвсегда\b/ никогда не срабатывал, и правило
  // молча существовало только на бумаге. Проверяем, что каждый шаблон реально ловит фразу.
  it("keeps every risk pattern alive on a representative phrase", async () => {
    const patterns = [...(await sourceOf("./semantic-claims.mjs")).matchAll(
      /\["([a-z_]+)", (\/.+\/[a-z]*)\]/gu,
    )];
    expect(patterns.length).toBeGreaterThanOrEqual(7);
    const phrases = {
      guarantee: "Мы гарантируем результат.",
      absolute_risk_removal: "Норма полностью снимает имущественные риски владельца.",
      causality: "Такой подход позволяет избежать спора.",
      legal_obligation: "Суд обязан применить эту норму.",
      court_outcome: "Суд отказал в удовлетворении требования.",
      risk_reduction: "Это снижает риск отказа.",
      universality: "Такое условие работает всегда.",
    };
    for (const [code] of patterns.map((match) => [match[1]])) {
      expect(Object.keys(phrases)).toContain(code);
    }
    for (const [code, phrase] of Object.entries(phrases)) {
      const result = await validateSemanticClaims({ text: phrase, sources: [] }, { adapter: null });
      expect(result.claimVerdicts[0].riskCodes, `${code}: шаблон не сработал`).toContain(code);
    }
  });
});

describe("Semantic gate severity", () => {
  const source = {
    id: "knowledge-446",
    text: "Статья 446 ГПК РФ защищает единственное пригодное для постоянного проживания жильё.",
  };

  it("sends an unverifiable editorial judgement to human review instead of discarding the plan", async () => {
    const result = await validateSemanticClaims(
      { text: "Это снижает риск пропустить важное условие в договоре.", sources: [] },
      { adapter: null },
    );
    expect(result.status).toBe("not_checked");
    expect(result.claimVerdicts[0]).toMatchObject({
      verdict: "unknown",
      reasonCode: "unverified_risk_reduction",
    });
    expect(result.reviewClaims).toHaveLength(1);
    expect(result.blockers).toHaveLength(0);
  });

  it("still refuses a promised outcome and a claim the source contradicts", async () => {
    const promised = await validateSemanticClaims(
      { text: "Эта норма гарантирует результат по каждому делу.", sources: [source] },
      { adapter: null },
    );
    expect(promised.status).toBe("blocked");
    expect(promised.claimVerdicts[0].verdict).toBe("unsupported");

    const contradicted = await validateSemanticClaims(
      {
        text: "Статья 446 ГПК РФ не защищает единственное пригодное для постоянного проживания жильё.",
        sources: [source],
      },
      { adapter: null },
    );
    expect(contradicted.status).toBe("blocked");
    expect(contradicted.claimVerdicts[0].reasonCode).toBe("source_contradiction");
  });

  it("never lets a risk claim reach the supported verdict, even with a permissive adapter", async () => {
    const result = await validateSemanticClaims(
      { text: "Это снижает риск отказа в регистрации.", sources: [source] },
      {
        adapter: {
          id: "qa-nli-v1",
          async check({ claims }) {
            return {
              verdicts: claims.map((claim) => ({
                claimId: claim.id,
                verdict: "supported",
                evidenceIds: [source.id],
              })),
            };
          },
        },
      },
    );
    expect(result.claimVerdicts[0].verdict).not.toBe("supported");
    expect(result.passed).toBe(false);
  });
});
