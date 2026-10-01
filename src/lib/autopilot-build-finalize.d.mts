export interface AutopilotPlanClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

export interface AutopilotBuildPlaceholderScope {
  projectId: number | string;
  channelId: number | string;
  planId: number | string;
  resultPlanId?: number | string | null;
}

export interface AutopilotAttemptSupersedeScope {
  projectId: number | string;
  channelId: number | string;
  keepPlanId?: number | string | null;
}

export const AUTOPILOT_COMMITTED_RESULT_STATUSES: string[];

export function committedAutopilotResultExistsSql(alias?: string): string;

export function finalizeAutopilotBuildPlaceholder(
  client: AutopilotPlanClient,
  scope: AutopilotBuildPlaceholderScope,
): Promise<{ finalized: boolean }>;

export function supersedeAutopilotAttempts(
  client: AutopilotPlanClient,
  scope: AutopilotAttemptSupersedeScope,
): Promise<{ superseded: number }>;
