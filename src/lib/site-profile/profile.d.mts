export const SITE_PROFILE_VERSION: "site-profile-v1";
export const SITE_PROFILE_EXPECTED_PAGE_TYPES: ReadonlyArray<readonly [string, string, "high" | "medium" | "low"]>;
export const SITE_PROFILE_LINKABLE_TYPES: readonly string[];

export type SiteProfileTopic = Readonly<{
  key: string;
  label: string;
  pageCount: number;
  occurrences: number;
  coverage: "strong" | "thin";
  pageUrls: readonly string[];
}>;

export type SiteProfileGap = Readonly<{
  key: string;
  kind: "page_type_missing" | "schema_missing" | "question_without_answer" | "thin_topic";
  severity: "high" | "medium" | "low";
  label: string;
  detail: string;
  evidenceUrls: readonly string[];
}>;

export type SiteProfileIssue = Readonly<{
  id: string;
  label: string;
  status: "critical" | "warning";
  detail: string;
  recommendation: string;
}>;

export type SiteProfileTechnical = Readonly<{
  pagesChecked: number;
  failedPages: number;
  seoScore: number | null;
  seoStatus: string | null;
  geoScore: number | null;
  geoStatus: string | null;
  seoIssues: readonly SiteProfileIssue[];
  geoIssues: readonly SiteProfileIssue[];
  notChecked: readonly string[];
  orphanCandidates: number | null;
}>;

export type SiteProfileLinkablePage = Readonly<{ url: string; title: string; pageType: string }>;

export type SiteProfile = Readonly<{
  profileVersion: string;
  confirmedDomain: string;
  checkedAt: string;
  pageCount: number;
  publicationCount: number;
  lastPublishedAt: string | null;
  pageTypeCounts: Readonly<Record<string, number>>;
  topics: readonly SiteProfileTopic[];
  gaps: readonly SiteProfileGap[];
  technical: SiteProfileTechnical;
  questions: Readonly<{
    pagesWithQuestions: number;
    answeredPages: number;
    faqSchemaPages: number;
    unansweredQuestions: number;
  }>;
  linkablePages: readonly SiteProfileLinkablePage[];
  summary: string;
}>;

export function classifySitePages(pages: unknown): ReadonlyArray<Readonly<Record<string, unknown>>>;
export function formatPagesCount(count: number): string;
export function buildSiteProfile(input: {
  confirmedDomain: string;
  pages: unknown;
  report?: Record<string, unknown> | null;
  checkedAt?: string | Date | null;
}): SiteProfile;
