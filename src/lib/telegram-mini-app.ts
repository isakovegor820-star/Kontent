import { createHmac, timingSafeEqual } from "node:crypto";

export type TelegramMiniAppIdentity = {
  userId: number;
  authDate: number;
  queryId: string | null;
};

export function validateTelegramMiniAppData(
  initData: string,
  botToken: string,
  options: { nowSeconds?: number; maxAgeSeconds?: number } = {},
): TelegramMiniAppIdentity | null {
  const raw = String(initData || "").trim();
  const token = String(botToken || "").trim();
  if (!raw || !token || raw.length > 16_000) return null;
  const params = new URLSearchParams(raw);
  const receivedHash = params.get("hash") || "";
  if (!/^[0-9a-f]{64}$/iu.test(receivedHash)) return null;
  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(checkString).digest();
  const received = Buffer.from(receivedHash, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  const authDate = Number(params.get("auth_date"));
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? 600;
  if (!Number.isSafeInteger(authDate) || authDate <= 0 || authDate > now + 30 || now - authDate > maxAge) return null;
  let user: unknown;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
  const userId = Number((user as { id?: unknown } | null)?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  return { userId, authDate, queryId: params.get("query_id") || null };
}
