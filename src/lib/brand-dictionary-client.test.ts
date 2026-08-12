import { describe, expect, it } from "vitest";

import { parseBrandDictionaryResponse } from "./brand-dictionary-client";

describe("brand dictionary client contract", () => {
  it("accepts the exact project-scoped dictionary response", () => {
    expect(parseBrandDictionaryResponse({
      ok: true,
      dictionary: {
        projectId: 23,
        version: 2,
        updatedAt: null,
        entries: [{
          id: 7,
          kind: "exception",
          term: "точная цитата",
          replacement: null,
          expansion: null,
          caseSensitive: true,
          version: 1,
        }],
      },
    })).toMatchObject({ projectId: 23, version: 2, entries: [{ kind: "exception" }] });
  });

  it("rejects malformed versions and unknown kinds", () => {
    expect(parseBrandDictionaryResponse({
      ok: true,
      dictionary: {
        projectId: 23,
        version: 0,
        updatedAt: null,
        entries: [],
      },
    })).toBeNull();
    expect(parseBrandDictionaryResponse({
      ok: true,
      dictionary: {
        projectId: 23,
        version: 1,
        updatedAt: null,
        entries: [{
          id: 1,
          kind: "secret",
          term: "x",
          replacement: null,
          expansion: null,
          caseSensitive: false,
          version: 1,
        }],
      },
    })).toBeNull();
  });
});
