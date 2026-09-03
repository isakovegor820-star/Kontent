import type { AuroraProductEventDraft } from "./product-event-contract.mjs";

export type ProductEventQueryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: unknown[] }>;
};

export function observeRelease(
  db: ProductEventQueryable,
  release: Readonly<{ release: string | null; commitSha: string | null; deployedAt: string | null }>,
): Promise<void>;

export function insertProductEvent(
  db: ProductEventQueryable,
  input: {
    event: AuroraProductEventDraft;
    actorUserId: number;
    projectId: number;
    fallbackRequestId: string;
    release: Readonly<{ release: string | null }>;
  },
): Promise<boolean>;
