import type { ApprovalBlocker, AutopilotApprovalEvaluation } from "./autopilot-approval.mjs";

export const AUTOPILOT_CALENDAR_PLAN_LIMIT: number;

export type AutopilotCalendarPlanState = "ready" | "expired" | "blocked";

export interface AutopilotPlanSourceItem {
  i?: number;
  scheduledAt?: string;
  topic?: string;
  draft?: string;
  status?: string;
  postId?: number;
  media?: unknown;
  formatting?: unknown;
  approvalBlockers?: ApprovalBlocker[];
  [key: string]: unknown;
}

export interface AutopilotPlanSourceRow {
  id: number | string;
  channel_id: number | string;
  status: string;
  revision: number | string;
  items: AutopilotPlanSourceItem[];
  channel_title?: string | null;
}

export interface AutopilotCalendarPlanItem {
  key: string;
  id: string;
  planId: number;
  planRevision: number;
  planStatus: string;
  index: number;
  channelId: number | null;
  channelTitle: string | null;
  scheduledAt: string;
  topic: string;
  text: string;
  media: unknown;
  formatting: unknown[];
  state: AutopilotCalendarPlanState;
  statusLabel: string;
  issues: string[];
  selectable: boolean;
  editable: boolean;
}

export function autopilotPlanItemState(input: {
  item: AutopilotPlanSourceItem;
  evaluation: AutopilotApprovalEvaluation;
  planStatus: string;
}): { state: AutopilotCalendarPlanState; issues: string[]; statusLabel: string; selectable: boolean; editable: boolean };

export function autopilotPlanCalendarItems(input?: {
  plans?: AutopilotPlanSourceRow[];
  nowMs?: number;
  canPublish?: boolean;
  canEdit?: boolean;
  limit?: number;
  /** Актуальные версии связанных черновиков: id → version. */
  draftVersions?: Map<number, number> | null;
}): AutopilotCalendarPlanItem[];
