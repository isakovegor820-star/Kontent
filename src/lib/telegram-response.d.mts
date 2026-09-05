export function readTelegramResponse(response: Pick<Response, "json" | "status">): Promise<Record<string, unknown> & { ok: boolean }>;
export function classifyTelegramDelivery(response: unknown, options?: { messageCount?: number; group?: boolean }):
  | { kind: "accepted"; messageIds: number[] }
  | { kind: "rejected"; providerErrorCode: number; retryAfterSeconds: number | null }
  | { kind: "unknown" };
