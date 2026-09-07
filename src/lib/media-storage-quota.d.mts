import type { Pool } from "pg";
export function mediaStorageError(error: unknown): { code: "media_storage_quota_exceeded" | "media_storage_unavailable"; status: number } | null;
export function mediaStorageErrorLabel(code: unknown): string | null;
export function parseMediaStorageLimits(input: Record<string, unknown>): { userMaxBytes: number; projectMaxBytes: number; globalMaxBytes: number };
export function configureMediaStorageLimits(pool: Pool, input: Record<string, unknown>, options?: { apply?: boolean }): Promise<Record<string, unknown>>;
