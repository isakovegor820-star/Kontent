import { describe, expect, it, vi } from "vitest";

import {
  chooseMediaStorageBackend,
  loadMediaAssetBuffer,
  parseMediaRange,
  postgresMediaStream,
} from "./media-storage.mjs";

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

  it("loads PostgreSQL media only through the selected project boundary", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        kind: "image",
        file_name: "card.png",
        mime_type: "image/png",
        bytes: 4,
        storage_backend: "postgres",
        object_key: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ data: Buffer.from("card") }] });

    await expect(loadMediaAssetBuffer({
      pool: { query },
      assetId: 91,
      projectId: 23,
      maxBytes: 100,
      env: {},
    })).resolves.toMatchObject({ file_name: "card.png", data: Buffer.from("card") });
    expect(query).toHaveBeenNthCalledWith(1, expect.any(String), [91, 23]);
    expect(query).toHaveBeenNthCalledWith(2, expect.any(String), [91, 23]);
  });

  it("streams PostgreSQL media with the project id in every chunk query", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ chunk: Buffer.from("abc") }] });
    const stream = postgresMediaStream({
      pool: { query },
      assetId: 91,
      projectId: 23,
      start: 0,
      end: 2,
      chunkBytes: 3,
    });

    const reader = stream.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: new Uint8Array(Buffer.from("abc")) });
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(query).toHaveBeenCalledWith(expect.any(String), [91, 23, 1, 3]);
  });
});
