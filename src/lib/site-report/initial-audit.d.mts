import type { SiteProfile } from "../site-profile/profile.mjs";

export const SITE_REPORT_VERSION: "site-report-v1";
export const SITE_REPORT_KINDS: readonly ["initial_audit", "monthly", "on_demand"];
export const SITE_REPORT_SEO_INTEGRATIONS: readonly string[];

export type SiteReportRecommendation = Readonly<{
  key: string;
  source: "seo" | "geo" | "content";
  priority: "P0" | "P1" | "P2";
  title: string;
  rationale: string;
  status: "open" | "done";
}>;

export type SiteReportPayload = Readonly<Record<string, unknown>> & Readonly<{
  reportVersion: string;
  kind: "initial_audit" | "monthly" | "on_demand";
  generatedAt: string;
  recommendations: readonly SiteReportRecommendation[];
  limitations: readonly string[];
}>;

export type SiteReport = Readonly<{ payload: SiteReportPayload; summaryRu: string }>;

export function buildInitialAuditSummary(input: {
  site: { confirmedDomain: string };
  profile: SiteProfile;
  recommendations: readonly SiteReportRecommendation[];
}): string;

export function buildInitialAuditReport(input: {
  site: { confirmedDomain: string; canonicalUrl?: string | null; verificationState?: string | null };
  profile: SiteProfile;
  analysis?: { analysisId?: number | null; runRevision?: number | null; snapshotHash?: string | null };
  generatedAt?: string | Date | null;
}): SiteReport;
