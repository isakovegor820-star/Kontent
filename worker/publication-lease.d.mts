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
  input: { postId: number; projectId: number; scheduleRevision: number; leaseToken: string; expectedChannel?: Record<string, unknown> },
): Promise<boolean>;

export function claimPublicationPart(
  pool: Queryable,
  input: { postId: number; projectId: number; scheduleRevision: number; leaseToken: string; partId: number; expectedChannel?: Record<string, unknown> },
): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;

export function authorizeProviderStep(
  pool: Queryable,
  input: { postId: number; projectId: number; scheduleRevision: number; leaseToken: string; expectedChannel?: Record<string, unknown> },
): Promise<boolean>;
