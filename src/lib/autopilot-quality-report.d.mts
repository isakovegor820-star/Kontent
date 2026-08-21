export type QualityFailureFix = "knowledge" | "settings" | "retry" | "review";
export type PublicationDisposition = "ready" | "confirmation_required" | "blocked";
export type QualityRepairStrategy = "deterministic_format" | "rewrite" | "add_knowledge"
  | "human_review" | "provider_retry" | "settings_change";

export interface QualityFailureGuideEntry {
  title: string;
  action: string;
  fix: QualityFailureFix;
  publicationDisposition: PublicationDisposition;
  repairStrategy: QualityRepairStrategy;
}

export const QUALITY_FAILURE_GUIDE: Readonly<Record<string, QualityFailureGuideEntry>>;

export interface AutopilotQualityFailureCause extends QualityFailureGuideEntry {
  code: string;
  count: number;
}

export interface AutopilotQualityFailureReport {
  total: number;
  passed: number;
  failed: number;
  drafts: number;
  causes: AutopilotQualityFailureCause[];
  primaryFix: QualityRepairStrategy | null;
}

export function autopilotQualityFailureReport(
  items: unknown,
  expected?: number | null,
): AutopilotQualityFailureReport;
export function autopilotQualityDisposition(result: unknown): {
  publicationDisposition: PublicationDisposition;
  repairStrategy: QualityRepairStrategy | null;
};
