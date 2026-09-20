import type { Pool, PoolClient } from "pg";
export function mediaObjectConfig(env?: NodeJS.ProcessEnv): null | Record<string, unknown>;
export function chooseMediaStorageBackend(input: { kind: string; bytes: number; env?: NodeJS.ProcessEnv }): "postgres" | "object";
export function putMediaObject(input: { projectId: number; sha256: string; extension: string; mimeType: string; body: Buffer; env?: NodeJS.ProcessEnv }): Promise<{ key: string; etag: string | null }>;
export function signedMediaObjectUrl(input: { key: string; fileName: string; download?: boolean; env?: NodeJS.ProcessEnv }): Promise<string>;
export function deleteMediaObject(key: string, env?: NodeJS.ProcessEnv): Promise<void>;
export function loadMediaAssetBuffer(input: {
  pool: Pick<Pool, "query">;
  assetId: number;
  projectId: number;
  maxBytes: number;
  env?: NodeJS.ProcessEnv;
}): Promise<null | { kind: string; file_name: string; mime_type: string; bytes: number; sha256: string; data: Buffer }>;
export type MediaRange = { start: number; end: number; length: number } | { error: "invalid_range" } | null;
export function parseMediaRange(value: string | null, bytes: number): MediaRange;
export function postgresMediaStream(input: {
  pool: Pick<Pool, "query">;
  assetId: number;
  projectId: number;
  start: number;
  end: number;
  chunkBytes?: number;
  onFinish?: (outcome: "completed" | "failed" | "cancelled") => void;
}): ReadableStream<Uint8Array>;
export function cleanupMediaObjectOrphans(input: {
  pool: Pick<Pool, "connect">;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ scanned: number; deleted: number; retained: number; failed: number }>;

export function withJournaledMediaObject<T>(input: { pool: Pick<Pool, "connect">; projectId: number; sha256: string; extension: string; mimeType: string; body: Buffer; env?: NodeJS.ProcessEnv }, persist: (object: { key: string; etag: string | null }, client: PoolClient) => Promise<T>): Promise<T>;

export function mediaObjectRangeStream(input: { key: string; start: number; end: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<ReadableStream<Uint8Array>>;
export function authorizedMediaStream(source: ReadableStream<Uint8Array>, authorize: () => Promise<unknown>, options?: { maxBytes?: number }): ReadableStream<Uint8Array>;
