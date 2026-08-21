export function serializeAutopilotPublicItem(source: unknown): Record<string, unknown>;
export function serializeAutopilotActivePlan(
  row: Record<string, unknown> | null | undefined,
  items?: unknown,
): Record<string, unknown> | null;
export function autopilotBuildAttemptDto(
  row: Record<string, unknown> | null | undefined,
  expected?: number | null,
): Record<string, unknown> | null;
