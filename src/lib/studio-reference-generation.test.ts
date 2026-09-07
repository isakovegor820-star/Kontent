import { describe, expect, it } from "vitest";

import {
  studioReferenceGenerationIdentity,
  recoverStudioReferenceGenerationIdentity,
  validStudioReferenceResultKey,
} from "./studio-reference-generation";

describe("studio reference generation identity", () => {
  it("is stable across reloads and valid for both paid request and draft replay", () => {
    const first = studioReferenceGenerationIdentity(7, 3);
    const replay = studioReferenceGenerationIdentity(7, 3);

    expect(replay).toEqual(first);
    expect(first).toEqual({
      requestKey: "studio_reference_7_v3",
      resultClientKey: "draft_result_studio_reference_7_v3",
    });
    expect(validStudioReferenceResultKey(first.resultClientKey)).toBe(true);
  });

  it("rejects unsafe draft identities", () => {
    expect(() => studioReferenceGenerationIdentity(0, 1)).toThrow(RangeError);
    expect(() => studioReferenceGenerationIdentity(1, Number.NaN)).toThrow(RangeError);
  });

  it("changes the paid-operation fingerprint when the owned draft version changes", () => {
    expect(studioReferenceGenerationIdentity(7, 4).requestKey)
      .not.toBe(studioReferenceGenerationIdentity(7, 3).requestKey);
  });
});


describe("N48 explicit reference restart identity", () => {
  const input = { draftId: 7, version: 3, channelId: 42 };
  const generation = { cmd: "write" as const, input: "Original task", variant: 0, history: [],
    referenceDraftId: 7, referenceDraftVersion: 3, referenceIntent: "create" as const,
    channelId: 42, requestKey: "explicit-new-operation", requestCreatedAt: 100 };
  it("recovers the latest explicit key across reload without minting another key", () => {
    const old = { ...generation, requestKey: "earlier-new-operation", requestCreatedAt: 50 };
    expect(recoverStudioReferenceGenerationIdentity(input, [generation, old])).toMatchObject({
      requestKey: generation.requestKey, resultClientKey: `draft_result_${generation.requestKey}`,
      generation,
    });
  });
  it.each([
    { referenceDraftId: 8 }, { referenceDraftVersion: 4 }, { channelId: 99 },
    { referenceIntent: "discuss" as const }, { requestCreatedAt: undefined }, { requestKey: "bad" },
  ])("never recovers an unrelated or implicit operation %j", (override) => {
    expect(recoverStudioReferenceGenerationIdentity(input, [{ ...generation, ...override }]))
      .toMatchObject(studioReferenceGenerationIdentity(7, 3));
  });
});
