type QueryResult = { rows?: unknown[]; rowCount?: number | null };
type Queryable = { query: (sql: string, params: unknown[]) => Promise<QueryResult> };

export type ProfileHashRebaseReport = {
  projectId: number;
  legacyHash: string;
  currentHash: string;
  campaigns: number;
  plans: number;
  operations: number;
  skipped: boolean;
};

export type ProfileHashRebaseTotals = {
  projects: number;
  rebased: number;
  campaigns: number;
  plans: number;
  operations: number;
};

export const LEGACY_CONTENT_PROFILE_HASH_SELECT: string;

export function rebaseProjectProfileHashes(
  client: Queryable,
  projectId: number,
): Promise<ProfileHashRebaseReport>;

export function listProjectsWithMonthlyCampaigns(db: Queryable): Promise<number[]>;

export function rebaseLegacyProfileHashes(input: {
  pool: Queryable & { connect: () => Promise<Queryable & { release: () => void }> };
  onProject?: (report: ProfileHashRebaseReport) => void;
}): Promise<ProfileHashRebaseTotals>;
