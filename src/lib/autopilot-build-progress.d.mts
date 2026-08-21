export interface AutopilotBuildProgress {
  completed: number;
  total: number;
  reviewRequired: number;
  ready: number;
  failed: number;
  percent: number;
  stage: "preparing" | "generating" | "finalizing";
}

export interface AutopilotBuildMinuteEstimate {
  min: number;
  max: number;
}

export function estimateAutopilotBuildMinutes(
  total: unknown,
  completed?: unknown,
): AutopilotBuildMinuteEstimate;

export function autopilotTopicCheckpoints(
  topics: Record<string, unknown>[],
  slots: unknown[],
  now?: () => Date,
): Record<string, unknown>[];
export function autopilotCheckpointItem(
  item: Record<string, unknown>,
  now?: () => Date,
): Record<string, unknown>;
export function reusableAutopilotCheckpoint(
  item: Record<string, unknown> | null,
  topic: Record<string, unknown>,
  scheduledAt: unknown,
): boolean;
export function autopilotBuildProgress(items: unknown, expected: number): AutopilotBuildProgress;
export function autopilotRetryableItemIndexes(items: unknown): number[];
export function autopilotBuildActivityAt(createdAt: string | Date, items: unknown): Date;
