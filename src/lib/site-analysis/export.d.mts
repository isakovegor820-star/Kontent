export const SITE_ANALYSIS_EXPORT_FORMATS: readonly ["csv", "xlsx", "json", "pdf", "html", "markdown"];
export function buildSiteAnalysisExportSnapshot(input: Record<string, unknown>): Readonly<Record<string, unknown>>;
export function renderSiteAnalysisCsv(snapshot: Record<string, unknown>): Buffer;
export function renderSiteAnalysisJson(snapshot: Record<string, unknown>): Buffer;
export function renderSiteAnalysisHtml(snapshot: Record<string, unknown>): Buffer;
export function renderSiteAnalysisMarkdown(snapshot: Record<string, unknown>): Buffer;
export function renderSiteAnalysisPdf(snapshot: Record<string, unknown>): Promise<Buffer>;
export function renderSiteAnalysisExport(format: string, snapshot: Record<string, unknown>): Promise<{ bytes: Buffer; contentType: string; extension: string }>;
