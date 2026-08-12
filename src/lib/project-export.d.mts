export type ProjectExportKind = "content_plan" | "analytics";
export type ProjectExportFormat = "csv" | "xlsx" | "pdf";
export type ProjectExportFilters = Readonly<{
  projectId: string;
  channel: readonly string[];
  author: readonly string[];
  campaign: readonly string[];
  status: readonly string[];
}>;
export type ProjectExportProject = Readonly<{
  id: string | number;
  name: string;
  timezone: string;
}>;
export type ProjectExportPeriod = Readonly<{ from: string; to: string }>;
export type ProjectContentPlanRow = Readonly<{
  id?: string | number;
  projectId?: string | number;
  project_id?: string | number;
  scheduledAt: string | Date;
  timezone?: string;
  channel: string;
  rubric?: string;
  title: string;
  status: string;
  author?: string;
  approver?: string;
  campaign?: string;
  postUrl?: string;
  utmUrl?: string;
  shortUrl?: string;
}>;
export type ProjectAnalyticsRow = Readonly<{
  id?: string | number;
  projectId?: string | number;
  project_id?: string | number;
  publishedAt: string | Date;
  confirmed: boolean;
  channel: string;
  rubric?: string;
  title: string;
  status: string;
  author?: string;
  approver?: string;
  campaign?: string;
  postUrl?: string;
  shortUrl?: string;
  views?: number | null;
  reactions?: number | null;
  comments?: number | null;
  shares?: number | null;
  clicksTotal?: number | null;
  clicksUnique?: number | null;
  conversions?: number | null;
  trackerState?: string;
}>;
export type ProjectExportSnapshotInput = Readonly<{
  kind: ProjectExportKind;
  exportedAt: string | Date;
  project: ProjectExportProject;
  period: ProjectExportPeriod;
  filters?: Readonly<Partial<Record<"channel" | "author" | "campaign" | "status", string | readonly string[]>> & { projectId?: string | number }>;
  methodology?: string;
  rows: readonly (ProjectContentPlanRow | ProjectAnalyticsRow)[];
}>;
export type ProjectExportSnapshot = Readonly<{
  schemaVersion: "aurora-project-export-v1";
  kind: ProjectExportKind;
  exportedAt: string;
  project: Readonly<{ id: string; name: string; timezone: string }>;
  period: ProjectExportPeriod;
  filters: ProjectExportFilters;
  methodology: string;
  rows: readonly Readonly<ProjectContentPlanRow | ProjectAnalyticsRow>[];
}>;
export const PROJECT_EXPORT_FORMATS: readonly ProjectExportFormat[];
export const PROJECT_EXPORT_KINDS: readonly ProjectExportKind[];
export function createProjectExportSnapshot(input: ProjectExportSnapshotInput): ProjectExportSnapshot;
export function projectExportHash(value: unknown): string;
export function escapeSpreadsheetFormula(value: unknown): string;
export function renderProjectCsv(input: ProjectExportSnapshotInput): Buffer;
export function renderProjectXlsx(input: ProjectExportSnapshotInput): Buffer;
export function renderProjectPdf(input: ProjectExportSnapshotInput): Promise<Buffer>;
export function renderProjectExport(format: ProjectExportFormat, input: ProjectExportSnapshotInput): Promise<{
  bytes: Buffer;
  contentType: string;
  extension: ProjectExportFormat;
}>;
export function projectExportFilename(
  projectName: string,
  kind: ProjectExportKind,
  period: ProjectExportPeriod,
  extension: string,
): string;
export function projectExportContentDisposition(filename: string): string;
