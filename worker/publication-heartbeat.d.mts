export const PUBLICATION_HEARTBEAT_KEY: "aurora:worker:publication:heartbeat:v1";
export const PUBLICATION_HEARTBEAT_TTL_SECONDS: 30;
export const PUBLICATION_HEARTBEAT_INTERVAL_MS: 10000;
export const PUBLICATION_HEARTBEAT_ROLE: "publication";

export interface PublicationHeartbeat {
  version: 1;
  role: "publication";
  at: string;
}

export function workerModeHasPublication(mode?: string | null): boolean;
export function publicationHeartbeatPayload(atMs?: number): PublicationHeartbeat;
export function serializePublicationHeartbeat(atMs?: number): string;
export function publicationHeartbeatWrite(
  mode?: string | null,
  atMs?: number,
): { key: typeof PUBLICATION_HEARTBEAT_KEY; value: string; ttlSeconds: 30 } | null;
export function parsePublicationHeartbeat(
  raw: unknown,
  options?: { nowMs?: number; maxAgeMs?: number },
): PublicationHeartbeat | null;
