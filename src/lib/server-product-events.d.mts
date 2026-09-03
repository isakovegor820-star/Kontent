import type { AURORA_EVENT_OUTCOMES, AURORA_EVENT_STAGES } from "./product-event-contract.mjs";
import type { AuroraReleaseMetadata } from "./release-metadata.mjs";

export type ServerProductEventInput = {
  userId: number;
  projectId: number;
  sectionId: string;
  featureId: string;
  action: string;
  stage: (typeof AURORA_EVENT_STAGES)[number];
  outcome: (typeof AURORA_EVENT_OUTCOMES)[number];
  source: "api" | "worker" | "bot" | "system";
  operationKind: string;
  durationMs?: number | null;
  errorCode?: string | null;
  requestId?: string | null;
  operationId?: string | null;
  queue?: string | null;
  attempt?: number | null;
  resultKind?: string | null;
  occurredAt?: string;
};

export type ServerProductEventPool = {
  connect: () => Promise<{
    query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: unknown[] }>;
    release: () => void;
  }>;
};

export function recordChannelProductEvent(
  pool: ServerProductEventPool & {
    query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: unknown[] }>;
  },
  input: Omit<ServerProductEventInput, "projectId"> & { channelId: number },
  options?: { release?: AuroraReleaseMetadata; nowMs?: number; logger?: Pick<Console, "error"> },
): Promise<boolean>;

export function safeProductErrorCode(value: unknown, fallback: string): string;
export function productDurationMs(startedAtMs: number, nowMs?: number): number | null;
export function recordServerProductEvent(
  pool: ServerProductEventPool,
  input: ServerProductEventInput,
  options?: { release?: AuroraReleaseMetadata; nowMs?: number; logger?: Pick<Console, "error"> },
): Promise<boolean>;
