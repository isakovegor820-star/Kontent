import { describe, expect, it, vi } from "vitest";

import { createConfiguredSemanticAdapter } from "./ai-semantic-adapter.mjs";

const evidence = [{
  id: "source-1",
  text: "Статья 446 ГПК РФ регулирует исполнительский иммунитет единственного жилья.",
  start: 0,
  end: 82,
}];
const claims = [{ id: "claim-1", text: "Статья 446 ГПК РФ регулирует исполнительский иммунитет." }];

describe("configured semantic AI adapter", () => {
  it("is fail-closed unless a supported configured engine is explicitly selected", () => {
    expect(createConfiguredSemanticAdapter({ env: { NAVYAI_API_KEY: "secret" } })).toBeNull();
    expect(createConfiguredSemanticAdapter({
      env: { AI_SEMANTIC_ENGINE: "yandex", NAVYAI_API_KEY: "secret" },
    })).toBeNull();
  });

  it("uses the explicitly validated engine and keeps only known source identifiers", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({
          verdicts: [{
            claimId: "claim-1",
            verdict: "supported",
            evidenceIds: ["source-1", "invented-source"],
            reasonCode: "direct_source_support",
          }],
        }) },
      }],
    }));
    const env = {
      AI_SEMANTIC_ENGINE: "navy-deepseek-pro",
      AI_FALLBACK_ENGINES: "navy-deepseek-flash",
      NAVYAI_API_KEY: "secret",
      NAVYAI_API_URL: "https://navy.example/v1",
    };
    const adapter = createConfiguredSemanticAdapter({ env, fetchImpl });

    await expect(adapter.check({ claims, evidence })).resolves.toEqual({
      verdicts: [{
        claimId: "claim-1",
        verdict: "supported",
        evidenceIds: ["source-1"],
        reasonCode: "direct_source_support",
      }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://navy.example/v1/chat/completions");
  });

  it("does not move a safety verdict to an unvalidated fallback model", async () => {
    const fetchImpl = vi.fn(async () => new Response("temporary", { status: 503 }));
    const adapter = createConfiguredSemanticAdapter({
      env: {
        AI_SEMANTIC_ENGINE: "navy-deepseek-pro",
        AI_FALLBACK_ENGINES: "navy-deepseek-flash",
        NAVYAI_API_KEY: "secret",
        NAVYAI_API_URL: "https://navy.example/v1",
      },
      fetchImpl,
    });

    await expect(adapter.check({ claims, evidence })).rejects.toMatchObject({
      code: "provider_error",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("treats malformed or non-terminal model output as no semantic proof", async () => {
    const env = {
      AI_SEMANTIC_ENGINE: "openai",
      OPENAI_API_KEY: "secret",
      AI_FALLBACK_ENGINES: "",
    };
    const malformed = createConfiguredSemanticAdapter({
      env,
      fetchImpl: vi.fn(async () => Response.json({
        choices: [{ finish_reason: "stop", message: { content: "not-json" } }],
      })),
    });
    await expect(malformed.check({ claims, evidence })).resolves.toEqual({ verdicts: [] });

    const truncated = createConfiguredSemanticAdapter({
      env,
      fetchImpl: vi.fn(async () => Response.json({
        choices: [{ finish_reason: null, message: { content: "{}" } }],
      })),
    });
    await expect(truncated.check({ claims, evidence })).rejects.toMatchObject({
      code: "stream_truncated",
    });
  });

  it("keeps an explicit non-factual verdict without inventing evidence", async () => {
    const env = {
      AI_SEMANTIC_ENGINE: "openai",
      OPENAI_API_KEY: "secret",
      AI_FALLBACK_ENGINES: "",
    };
    const adapter = createConfiguredSemanticAdapter({
      env,
      fetchImpl: vi.fn(async () => Response.json({
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({
            verdicts: [{
              claimId: "claim-1",
              verdict: "non_factual",
              evidenceIds: ["source-1"],
              reasonCode: "section_heading",
            }],
          }) },
        }],
      })),
    });

    await expect(adapter.check({ claims, evidence })).resolves.toEqual({
      verdicts: [{
        claimId: "claim-1",
        verdict: "non_factual",
        evidenceIds: ["source-1"],
        reasonCode: "section_heading",
      }],
    });
  });
});
