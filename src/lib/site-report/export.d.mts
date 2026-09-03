export const SITE_REPORT_EXPORT_FORMATS: readonly ["json", "markdown", "html", "pdf"];

export type SiteReportExportInput = Readonly<{ payload: Record<string, unknown>; summaryRu: string; interpretation?: Record<string, unknown> | null }>;

export function buildSiteReportSections(report: SiteReportExportInput): ReadonlyArray<Record<string, unknown>>;
export function renderSiteReportJson(report: SiteReportExportInput): Buffer;
export function renderSiteReportMarkdown(report: SiteReportExportInput): Buffer;
export function renderSiteReportHtml(report: SiteReportExportInput): Buffer;
export function renderSiteReportPdf(report: SiteReportExportInput): Promise<Buffer>;
export function renderSiteReportExport(format: string, report: SiteReportExportInput): Promise<{ bytes: Buffer; contentType: string; extension: string }>;
