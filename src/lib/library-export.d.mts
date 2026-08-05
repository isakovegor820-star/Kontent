export type LibraryExportSnapshot = {
  exportedAt: string;
  activeFilters: Record<string, unknown>;
  formulaVersion: string;
  items: Array<Record<string, unknown>>;
};
export const LIBRARY_EXPORT_FORMATS: readonly ["csv", "xlsx", "json", "pdf", "html", "markdown"];
export function renderLibraryCsv(snapshot: LibraryExportSnapshot): Buffer;
export function renderLibraryXlsx(snapshot: LibraryExportSnapshot): Buffer;
export function renderTabularXlsx(rows: unknown[][], sheetName?: string): Buffer;
export function renderLibraryJson(snapshot: LibraryExportSnapshot): Buffer;
export function libraryPdfItemLines(item: Record<string, unknown>): string[];
export function resolveLibraryPdfFontPath(options?: {
  cwd?: string;
  moduleResolve?: (specifier: string) => string;
  exists?: (path: string) => boolean;
}): string;
export function renderLibraryPdf(snapshot: LibraryExportSnapshot): Promise<Buffer>;
export function renderLibraryHtml(snapshot: LibraryExportSnapshot): Buffer;
export function renderLibraryMarkdown(snapshot: LibraryExportSnapshot): Buffer;
export function renderLibraryExport(format: string, snapshot: LibraryExportSnapshot): Promise<{
  bytes: Buffer;
  contentType: string;
  extension: string;
}>;
