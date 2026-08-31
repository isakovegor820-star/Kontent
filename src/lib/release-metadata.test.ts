import { describe, expect, it } from "vitest";

import { auroraReleaseMetadata } from "./release-metadata";

describe("safe Aurora release metadata", () => {
  it("uses explicit safe runtime metadata", () => {
    expect(auroraReleaseMetadata({
      AURORA_RELEASE: "aurora-2026.08.30",
      AURORA_RELEASE_SHA: "a".repeat(40),
      AURORA_DEPLOYED_AT: "2026-08-30T10:00:00.000Z",
    })).toEqual({
      release: "aurora-2026.08.30",
      commitSha: "a".repeat(40),
      deployedAt: "2026-08-30T10:00:00.000Z",
    });
  });

  it("returns null instead of leaking invalid environment values", () => {
    expect(auroraReleaseMetadata({
      AURORA_RELEASE: "https://deploy.example/private",
      AURORA_RELEASE_SHA: "not-a-sha",
      AURORA_DEPLOYED_AT: "yesterday",
    })).toEqual({ release: null, commitSha: null, deployedAt: null });
  });

  it("falls back to the deploy commit when a release label is absent", () => {
    expect(auroraReleaseMetadata({ AURORA_DEPLOY_SHA: "abcdef1234567" }))
      .toEqual({ release: "abcdef1234567", commitSha: "abcdef1234567", deployedAt: null });
  });
});
