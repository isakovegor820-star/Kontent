import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send(...args) { return mocks.send(...args); } },
  GetObjectCommand: class { constructor(input) { this.input = input; } },
  PutObjectCommand: class {}, DeleteObjectCommand: class {},
}));
import { authorizedMediaStream, mediaObjectRangeStream } from "./media-storage.mjs";
const env = { MEDIA_OBJECT_BUCKET: "isolated", MEDIA_OBJECT_REGION: "test" };
afterEach(() => vi.clearAllMocks());
describe("private object media proxy", () => {
  it("requests only the authorized byte range through the SDK with a bounded abort signal", async () => {
    const upstream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1,2])); c.close(); } });
    mocks.send.mockResolvedValue({ ContentLength: 2, Body: { transformToWebStream: () => upstream } });
    const stream = await mediaObjectRangeStream({ key: "projects/23/media/a", start: 3, end: 4, env });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ input: { Bucket: "isolated", Key: "projects/23/media/a", Range: "bytes=3-4" } }), { abortSignal: expect.any(AbortSignal) });
    expect(await new Response(stream).arrayBuffer()).toEqual(new Uint8Array([1,2]).buffer);
  });
  it("refuses a provider response outside the requested byte bound", async () => {
    const destroy = vi.fn();
    mocks.send.mockResolvedValue({ ContentLength: 1000, Body: { destroy } });
    await expect(mediaObjectRangeStream({ key: "x", start: 0, end: 3, env })).rejects.toThrow("media_object_range_mismatch");
    expect(destroy).toHaveBeenCalledOnce();
  });
  it("cancels upstream and exposes no newly read bytes if membership is revoked during the read", async () => {
    let revoked = false;
    const cancelled = vi.fn();
    const source = new ReadableStream({ pull(c) { revoked = true; c.enqueue(new Uint8Array([99])); }, cancel: cancelled }, { highWaterMark: 0 });
    const stream = authorizedMediaStream(source, async () => { if (revoked) throw new Error("revoked"); });
    await expect(stream.getReader().read()).rejects.toThrow("revoked");
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("does not prefetch bytes or membership checks while the consumer has not requested them", async () => {
    const pull = vi.fn(); const authorize = vi.fn(); const cancel = vi.fn();
    const reader = authorizedMediaStream(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), authorize).getReader();
    await Promise.resolve();
    expect(pull).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
    await reader.cancel(); expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects extra or truncated provider bytes against the declared asset bound", async () => {
    const oversized = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(5)); c.close(); } });
    await expect(authorizedMediaStream(oversized, async () => {}, { maxBytes: 4 }).getReader().read()).rejects.toThrow("media_stream_exceeds_bound");
    const truncated = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2)); c.close(); } });
    const reader = authorizedMediaStream(truncated, async () => {}, { maxBytes: 4 }).getReader();
    expect((await reader.read()).value.byteLength).toBe(2);
    await expect(reader.read()).rejects.toThrow("media_stream_truncated");
  });

});
