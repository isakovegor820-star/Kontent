import { describe, expect, it } from "vitest";

import {
  acquireAvatarBodySlot,
  acquireMediaAssetBodySlot,
  BoundedBodyError,
  MAX_CONCURRENT_AVATAR_BODIES,
  MAX_CONCURRENT_MEDIA_ASSET_BODIES,
  readRequestBodyLimited,
} from "./bounded-request-body";

function stream(...chunks: number[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}

describe("bounded multipart body", () => {
  it("accepts a body exactly at the limit", async () => {
    await expect(readRequestBodyLimited(stream(2, 3), 5)).resolves.toHaveLength(5);
  });

  it("stops a chunked body when actual bytes exceed a forged smaller length", async () => {
    await expect(readRequestBodyLimited(stream(3, 3), 5))
      .rejects.toEqual(expect.objectContaining({ code: "too_large" } satisfies Partial<BoundedBodyError>));
  });

  it("caps concurrent in-process body allocations", () => {
    const releases = Array.from({ length: MAX_CONCURRENT_AVATAR_BODIES }, () => acquireAvatarBodySlot());
    expect(() => acquireAvatarBodySlot()).toThrowError(expect.objectContaining({ code: "upload_busy" }));
    for (const release of releases) release();
    const finalRelease = acquireAvatarBodySlot();
    finalRelease();
  });

  it("uses a stricter concurrency budget for large media assets", () => {
    const releases = Array.from(
      { length: MAX_CONCURRENT_MEDIA_ASSET_BODIES },
      () => acquireMediaAssetBodySlot(),
    );
    expect(() => acquireMediaAssetBodySlot())
      .toThrowError(expect.objectContaining({ code: "upload_busy" }));
    for (const release of releases) release();
    const finalRelease = acquireMediaAssetBodySlot();
    finalRelease();
  });
});
