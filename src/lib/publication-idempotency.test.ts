import { describe, expect, it } from "vitest";
import {
  draftDestinationIdempotencyKey,
  normalizeIdempotencyKey,
  publicationFingerprint,
  retryJobSuffix,
} from "./publication-idempotency";

describe("publication idempotency", () => {
  it("accepts bounded opaque keys and rejects unsafe/empty values", () => {
    expect(normalizeIdempotencyKey("qa-operation:1234")).toBe("qa-operation:1234");
    expect(normalizeIdempotencyKey("short")).toBeNull();
    expect(normalizeIdempotencyKey("bad key with spaces")).toBeNull();
  });

  it("returns the same fingerprint and retry job suffix for the same request", () => {
    const input = {
      userId: 1,
      channelId: 2,
      text: "Text",
      scheduledAt: "2026-08-02T12:00:00.000Z",
      media: null,
    };
    expect(publicationFingerprint(input)).toBe(publicationFingerprint({ ...input }));
    expect(retryJobSuffix("qa-operation:1234")).toBe(retryJobSuffix("qa-operation:1234"));
  });

  it("changes the fingerprint when the destination changes", () => {
    const base = {
      userId: 1,
      channelId: 2,
      text: "Text",
      scheduledAt: "2026-08-02T12:00:00.000Z",
      media: null,
    };
    expect(publicationFingerprint(base)).not.toBe(
      publicationFingerprint({ ...base, channelId: 3 }),
    );
  });

  it("uses a stable draft destination outcome key across text and date revisions", () => {
    const key = draftDestinationIdempotencyKey(41, 11);
    expect(key).toBe("draft:41:destination:11");
    expect(normalizeIdempotencyKey(key)).toBe(key);
    expect(draftDestinationIdempotencyKey(41, 11)).toBe(key);
    expect(draftDestinationIdempotencyKey(41, 12)).not.toBe(key);
    expect(() => draftDestinationIdempotencyKey(0, 11)).toThrow("invalid draft destination");
  });
});
