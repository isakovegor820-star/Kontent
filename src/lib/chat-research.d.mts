export type ChatResearchReason =
  | "content_request"
  | "external_event"
  | "freshness"
  | "legal"
  | "statistics"
  | "benchmark"
  | "explicit_request";

export type ChatResearchDecision = {
  needed: boolean;
  reasons: ChatResearchReason[];
  topic: string;
  categories: string[];
  confidence: number;
};

export const CHAT_RESEARCH_REASONS: readonly ChatResearchReason[];
export const CHAT_RESEARCH_REASON_LABELS: Readonly<Record<ChatResearchReason, string>>;

export function chatResearchTopic(value: unknown): string;
export function detectChatResearchNeed(input: {
  task?: string;
  input?: string;
  surface?: string;
  history?: Array<{ role?: string; text?: string; content?: string }>;
}): ChatResearchDecision;
export function chatResearchReasonText(reasons: unknown): string;

export function chatResearchEnabled(env?: Record<string, string | undefined>): boolean;
