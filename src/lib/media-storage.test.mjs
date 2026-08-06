import { describe, expect, it } from "vitest";

import { chooseMediaStorageBackend, parseMediaRange } from "./media-storage.mjs";

describe("media storage routing", () => {
  it("keeps legacy/small data in PostgreSQL and requires object storage for large video", () => {
    expect(chooseMediaStorageBackend({ kind: "image", bytes: 30_000_000, env: {} })).toBe("postgres");
    expect(chooseMediaStorageBackend({ kind: "video", bytes: 10, env: {
      MEDIA_OBJECT_VIDEO_THRESHOLD_BYTES: "20",
    } })).toBe("postgres");
    expect(() => chooseMediaStorageBackend({ kind: "video", bytes: 20, env: {
      MEDIA_OBJECT_VIDEO_THRESHOLD_BYTES: "20",
    } })).toThrowError(expect.objectContaining({ code: "object_storage_required" }));
    expect(chooseMediaStorageBackend({ kind: "video", bytes: 20, env: {
      MEDIA_OBJECT_VIDEO_THRESHOLD_BYTES: "20",
      MEDIA_OBJECT_BUCKET: "private-media",
      MEDIA_OBJECT_REGION: "eu-west-1",
    } })).toBe("object");
  });

  it("parses bounded byte ranges", () => {
    expect(parseMediaRange(null, 100)).toBeNull();
    expect(parseMediaRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9, length: 10 });
    expect(parseMediaRange("bytes=90-", 100)).toEqual({ start: 90, end: 99, length: 10 });
    expect(parseMediaRange("bytes=-10", 100)).toEqual({ start: 90, end: 99, length: 10 });
    expect(parseMediaRange("bytes=100-101", 100)).toEqual({ error: "invalid_range" });
    expect(parseMediaRange("bytes=0-1,5-6", 100)).toEqual({ error: "invalid_range" });
  });
});
