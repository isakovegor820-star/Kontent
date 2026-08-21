export function isAutopilotHumanReviewItem(item: unknown): boolean;
export function isAutopilotReaderReadyItem(item: unknown): boolean;
export function attestAutopilotItemForHumanApproval<T extends Record<string, unknown>>(
  item: T,
  attestor?: { userId?: number; attestedAt?: string | number | Date },
): T;
export function hasServerAutopilotHumanAttestation(item: unknown): boolean;
