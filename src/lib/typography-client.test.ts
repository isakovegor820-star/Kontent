import { afterEach, describe, expect, it, vi } from "vitest";

import { loadLatestTypographyRun } from "./typography-client";

const persistedRun = {
  id: 72,
  sourceText: "Срок  3-5 дней",
  resultText: "Срок  3-5 дней",
  dictionaryVersion: 3,
  rulesVersion: "aurora-ru-typographer-v2",
  rejectedSuggestionIds: ["typ-a1"],
  reviewComplete: true,
  currentReview: true,
  undone: false,
  duplicate: true,
};

describe("typography client persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads a durable review for the exact server draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      run: persistedRun,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadLatestTypographyRun(41)).resolves.toEqual(persistedRun);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/typography/runs/latest?draftId=41",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("rejects malformed server state instead of inventing a review", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      run: { ...persistedRun, rejectedSuggestionIds: "typ-a1" },
    }), { status: 200 })));

    await expect(loadLatestTypographyRun(41)).rejects.toThrow("invalid_response");
  });
});
