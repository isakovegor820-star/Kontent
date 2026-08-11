import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export {
  buildTrackedDestination,
  normalizeTrackingDestination,
  normalizeUtmValues,
  UTM_FIELDS,
  type UtmField,
  type UtmValues,
} from "./utm";

export type AttributionPayload = {
  version: 1;
  shortLinkId: number;
  clickId: string;
  issuedAt: number;
  expiresAt: number;
};

export function createShortLinkSlug() {
  return randomBytes(16).toString("base64url");
}

function encodePayload(payload: AttributionPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function signAttribution(
  input: Omit<AttributionPayload, "version" | "issuedAt" | "expiresAt">,
  secret: string,
  options: { now?: number; ttlSeconds?: number } = {},
) {
  if (secret.length < 32) throw new Error("attribution_secret_too_short");
  const issuedAt = Math.floor(options.now ?? Date.now() / 1000);
  const ttlSeconds = Math.min(Math.max(options.ttlSeconds ?? 30 * 24 * 60 * 60, 60), 90 * 24 * 60 * 60);
  const encoded = encodePayload({
    version: 1,
    shortLinkId: input.shortLinkId,
    clickId: input.clickId,
    issuedAt,
    expiresAt: issuedAt + ttlSeconds,
  });
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyAttribution(
  token: string,
  secret: string,
  options: { now?: number } = {},
): AttributionPayload | null {
  if (secret.length < 32) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let payload: AttributionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AttributionPayload;
  } catch {
    return null;
  }
  const now = Math.floor(options.now ?? Date.now() / 1000);
  if (
    payload.version !== 1
    || !Number.isSafeInteger(payload.shortLinkId)
    || payload.shortLinkId <= 0
    || !/^[A-Za-z0-9_-]{8,80}$/u.test(payload.clickId)
    || !Number.isSafeInteger(payload.issuedAt)
    || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt <= payload.issuedAt
    || payload.expiresAt - payload.issuedAt > 90 * 24 * 60 * 60
    || payload.issuedAt > now + 300
    || payload.expiresAt < now
  ) return null;
  return payload;
}

export function visitorFingerprint(input: { ip?: string | null; userAgent?: string | null }, secret: string) {
  if (secret.length < 32) throw new Error("fingerprint_secret_too_short");
  const ip = (input.ip ?? "unknown").trim().slice(0, 128);
  const userAgent = (input.userAgent ?? "unknown").trim().slice(0, 512);
  return createHmac("sha256", secret).update(`${ip}\u0000${userAgent}`).digest("hex");
}

export function classifyLikelyBot(userAgent: string | null | undefined) {
  const value = (userAgent ?? "").toLowerCase();
  if (!value) return true;
  return /(bot|crawler|spider|preview|facebookexternalhit|telegrambot|vkshare|headless|curl|wget)/u.test(value);
}

export function conversionIdempotencyHash(projectId: number, key: string) {
  const normalized = key.trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/u.test(normalized)) throw new Error("invalid_idempotency_key");
  return createHash("sha256").update(`${projectId}\u0000${normalized}`).digest("hex");
}
