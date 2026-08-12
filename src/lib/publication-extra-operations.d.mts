export type PublicationExtraKind = "first_comment" | "configure_comments" | "pin" | "unpin";
export type PublicationExtraSpec = {
  kind: PublicationExtraKind;
  sequenceIndex: number;
  fingerprint: string;
  idempotencyKey: string;
  requestSnapshot: Readonly<Record<string, unknown>>;
  initialStatus: "waiting_dependency" | "unsupported";
};

export const PUBLICATION_EXTRA_KINDS: readonly PublicationExtraKind[];
export function publicationExtraFingerprint(value: unknown): string;
export function buildPublicationExtraSpecs(input: Record<string, unknown>): PublicationExtraSpec[];
export function persistPublicationExtraSpecs(
  db: { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  input: Record<string, unknown>,
): Promise<Record<string, unknown>[]>;
export function persistPublicationReviewTask(
  db: { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  input: Record<string, unknown>,
): Promise<Record<string, unknown>>;
export function activateNextPublicationExtra(
  db: { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  input: { projectId: number; postId: number },
): Promise<number | null>;
