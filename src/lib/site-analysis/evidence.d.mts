export const SITE_OSINT_SNAPSHOT_VERSION: string;
export function sanitizeEvidenceUrl(value: unknown): string | null;
export function stableJson(value: unknown): string;
export function siteEvidenceHash(value: unknown): string;
export function classifySitePage(page: Record<string, unknown>): string;
export function buildSiteEvidenceSnapshot(input: {
  confirmedDomain: string;
  pages: Array<Record<string, unknown>>;
  checkedAt?: string | Date;
  coverageMode?: "site_only" | "external";
}): Readonly<{
  version: string;
  snapshotHash: string;
  coverage: Record<string, unknown>;
  sources: readonly Record<string, unknown>[];
  evidence: readonly Record<string, unknown>[];
  entities: readonly Record<string, unknown>[];
  relations: readonly Record<string, unknown>[];
}>;
