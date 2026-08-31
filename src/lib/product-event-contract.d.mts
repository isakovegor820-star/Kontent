export const PRODUCT_EVENT_PROPERTIES: Readonly<Record<string, readonly string[]>>;

export type ProductEventDraftValidation =
  | Readonly<{
      ok: true;
      event: Readonly<{
        name: string;
        properties: Readonly<Record<string, string | number | boolean | null>>;
      }>;
    }>
  | Readonly<{
      ok: false;
      error: string;
      property?: string;
    }>;

export function validateProductEventDraft(
  name: unknown,
  properties?: unknown,
): ProductEventDraftValidation;

export const AURORA_EVENT_STAGES: readonly [
  "started", "accepted", "queued", "processing", "completed", "failed", "retried", "cancelled",
];
export const AURORA_EVENT_OUTCOMES: readonly ["pending", "success", "failure", "cancelled"];
export const AURORA_PRODUCT_FEATURES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
export const AURORA_SECTION_IDS: readonly string[];
export const AURORA_SAFE_CONTEXT_PROPERTIES: Readonly<Record<string, readonly string[] | null>>;

export type AuroraProductEventDraft = Readonly<{
  eventId: string;
  sectionId: string;
  featureId: string;
  action: string;
  stage: typeof AURORA_EVENT_STAGES[number];
  outcome: typeof AURORA_EVENT_OUTCOMES[number];
  durationMs: number | null;
  errorCode: string | null;
  requestId: string | null;
  operationId: string | null;
  sessionId: string | null;
  occurredAt: string;
  safeContext: Readonly<Record<string, string | number>>;
  important: boolean;
}>;

export type AuroraProductEventValidation =
  | Readonly<{ ok: true; event: AuroraProductEventDraft }>
  | Readonly<{ ok: false; error: string; field?: string }>;

export function validateAuroraProductEventDraft(
  value: unknown,
  options?: Readonly<{ nowMs?: number }>,
): AuroraProductEventValidation;
