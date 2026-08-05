import { describe, expect, it } from "vitest";
import {
  PUBLICATION_HEARTBEAT_INTERVAL_MS,
  PUBLICATION_HEARTBEAT_KEY,
  PUBLICATION_HEARTBEAT_TTL_SECONDS,
  parsePublicationHeartbeat,
  publicationHeartbeatPayload,
  publicationHeartbeatWrite,
  serializePublicationHeartbeat,
  workerModeHasPublication,
} from "./publication-heartbeat.mjs";

const NOW = Date.parse("2026-08-01T20:00:00.000Z");

describe("publication worker heartbeat contract", () => {
  it("uses the stable web-readiness key, TTL and cadence", () => {
    expect(PUBLICATION_HEARTBEAT_KEY).toBe("aurora:worker:publication:heartbeat:v1");
    expect(PUBLICATION_HEARTBEAT_TTL_SECONDS).toBe(30);
    expect(PUBLICATION_HEARTBEAT_INTERVAL_MS).toBe(10_000);
  });

  it("allows only modes that actually construct the publish worker", () => {
    expect(workerModeHasPublication(undefined)).toBe(true);
    expect(workerModeHasPublication("")).toBe(true);
    expect(workerModeHasPublication("full")).toBe(true);
    expect(workerModeHasPublication("media")).toBe(false);
    expect(workerModeHasPublication("autopilot")).toBe(false);
    expect(workerModeHasPublication("publication")).toBe(true);
    expect(publicationHeartbeatWrite("media", NOW)).toBeNull();
    expect(publicationHeartbeatWrite("autopilot", NOW)).toBeNull();
    expect(publicationHeartbeatWrite("full", NOW)).toEqual({
      key: "aurora:worker:publication:heartbeat:v1",
      value: '{"version":1,"role":"publication","at":"2026-08-01T20:00:00.000Z"}',
      ttlSeconds: 30,
    });
  });

  it("serializes only version, publication role and an ISO timestamp", () => {
    const payload = publicationHeartbeatPayload(NOW);
    expect(payload).toEqual({
      version: 1,
      role: "publication",
      at: "2026-08-01T20:00:00.000Z",
    });
    expect(JSON.parse(serializePublicationHeartbeat(NOW))).toEqual(payload);
    expect(Object.keys(payload).sort()).toEqual(["at", "role", "version"]);
  });

  it("accepts a fresh heartbeat and rejects expired, future, malformed or expanded payloads", () => {
    const fresh = serializePublicationHeartbeat(NOW - 20_000);
    expect(parsePublicationHeartbeat(fresh, { nowMs: NOW })).toEqual({
      version: 1,
      role: "publication",
      at: "2026-08-01T19:59:40.000Z",
    });
    expect(parsePublicationHeartbeat(serializePublicationHeartbeat(NOW - 30_000), { nowMs: NOW })).toBeNull();
    expect(parsePublicationHeartbeat(serializePublicationHeartbeat(NOW + 10_001), { nowMs: NOW })).toBeNull();
    expect(parsePublicationHeartbeat('{"version":1,"role":"media","at":"2026-08-01T20:00:00.000Z"}', { nowMs: NOW })).toBeNull();
    expect(parsePublicationHeartbeat('{"version":1,"role":"publication","at":"2026-08-01"}', { nowMs: NOW })).toBeNull();
    expect(parsePublicationHeartbeat('{"version":1,"role":"publication","at":"2026-08-01T20:00:00.000Z","userId":1}', { nowMs: NOW })).toBeNull();
    expect(parsePublicationHeartbeat("not-json", { nowMs: NOW })).toBeNull();
  });

  it("rejects invalid serialization timestamps", () => {
    expect(() => serializePublicationHeartbeat(Number.NaN)).toThrow(TypeError);
  });
});
