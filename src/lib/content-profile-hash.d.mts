export const CONTENT_PROFILE_HASH_SELECT: string;

export function contentProfileHash(rows: unknown): string;

export function readContentProfileHash(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows?: unknown[] }> },
  projectId: number,
): Promise<string>;
