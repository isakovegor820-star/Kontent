import { describe, expect, it } from "vitest";

import {
  studioReferenceGenerationIdentity,
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
