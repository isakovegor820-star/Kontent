import { describe, expect, it } from "vitest";

import {
  acquireAvatarBodySlot,
  acquireMediaAssetBodySlot,
  BoundedBodyError,
  MAX_CONCURRENT_AVATAR_BODIES,
  MAX_CONCURRENT_MEDIA_ASSET_BODIES,
  readJsonBodyLimited,
  readJsonBodyValue,
  readRequestBodyLimited,
} from "./bounded-request-body";

function chunkedRequest(chunks: string[], headers?: HeadersInit) {
  const encoder = new TextEncoder();
  return {
    headers: new Headers(headers),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

describe("bounded request bodies", () => {
  it("reads a stream up to the exact byte limit", async () => {
    const bytes = await readRequestBodyLimited(chunkedRequest(["ab", "cd"]).body, 4);
    expect(new TextDecoder().decode(bytes)).toBe("abcd");
  });

  it("rejects JSON from Content-Length before reading the body", async () => {
    let bodyAccessed = false;
    const request = {
      headers: new Headers({ "content-length": "100" }),
      get body(): ReadableStream<Uint8Array> {
        bodyAccessed = true;
        throw new Error("body_should_not_be_read");
      },
    };

    await expect(readJsonBodyLimited(request, 16)).resolves.toEqual({
      ok: false,
      error: "payload_too_large",
      status: 413,
    });
    expect(bodyAccessed).toBe(false);
  });

  it("stops chunked JSON once its streaming budget is exceeded", async () => {
    await expect(readJsonBodyLimited(chunkedRequest(["{\"value\":", "\"too long\"}"]), 12))
      .resolves.toEqual({ ok: false, error: "payload_too_large", status: 413 });
  });

  it("distinguishes malformed JSON from an oversized body", async () => {
    await expect(readJsonBodyLimited(chunkedRequest(["{broken"]), 64))
      .resolves.toEqual({ ok: false, error: "bad_request", status: 400 });
  });

  it("returns a typed JSON value", async () => {
    await expect(readJsonBodyLimited<{ ok: boolean }>(chunkedRequest(["{\"ok\":true}"]), 64))
      .resolves.toEqual({ ok: true, value: { ok: true } });
  });

  it("offers a bounded Request.json-compatible helper", async () => {
    await expect(readJsonBodyValue<{ ok: boolean }>(chunkedRequest(["{\"ok\":true}"]), 64))
      .resolves.toEqual({ ok: true });
    await expect(readJsonBodyValue(chunkedRequest(["{\"value\":\"too long\"}"]), 8))
      .rejects.toMatchObject({
        code: "payload_too_large",
        status: 413,
      });
    await expect(readJsonBodyValue(chunkedRequest(["{broken"]), 64))
      .rejects.toBeInstanceOf(SyntaxError);
  });

  it("stops a chunked multipart body when actual bytes exceed a forged smaller length", async () => {
    await expect(readRequestBodyLimited(stream(3, 3), 5))
      .rejects.toEqual(expect.objectContaining({ code: "too_large" } satisfies Partial<BoundedBodyError>));
  });

  it("caps concurrent in-process avatar body allocations", () => {
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

function stream(...chunks: number[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size));
      controller.close();
    },
  });
}
