type Queryable = {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
};

export function claimPublicationLease(
  pool: Queryable,
  input: {
    postId: number;
    projectId: number;
    scheduleRevision: number;
    leaseToken: string;
    overdueCutoff: Date;
  },
): Promise<Record<string, unknown> | null>;

export function beginProviderCall(
  pool: Queryable,
  input: { postId: number; projectId: number; scheduleRevision: number; leaseToken: string },
): Promise<boolean>;
