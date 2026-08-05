import { describe, expect, it } from "vitest";

import {
  buildSiteAnalysisExportSnapshot,
  renderSiteAnalysisExport,
} from "./export.mjs";

const result = {
  osint: {
    reportStatus: "complete",
    promptVersion: "site-osint-interview-v1",
    questionCatalogVersion: "site-osint-questions-v1",
    snapshotHash: `sha256:${"a".repeat(64)}`,
    coverage: { mode: "site_only" },
    summary: { answered: 1, hypothesis: 0, conflicting: 0, insufficientData: 0, total: 1 },
    answers: [{
      questionId: "organization.identity",
      status: "answered",
      confidence: "high",
      shortAnswer: "=Аврора — сервис анализа.",
      explanation: "Описание подтверждено главной страницей.",
      facts: [{ statement: "Аврора анализирует сайты.", evidenceIds: ["ev_1"] }],
      evidenceIds: ["ev_1"],
      contradictions: [], gaps: [], requiredIntegrations: [], recommendationHooks: [],
    }],
    recommendations: [],
    marketingPlan: { publicationBacklog: [], measurement: [] },
  },
  snapshot: {
    snapshotHash: `sha256:${"a".repeat(64)}`,
    sources: [{ id: "src_1", kind: "owned_page", url: "https://example.com/", title: "Example" }],
    evidence: [{ id: "ev_1", sourceId: "src_1", type: "main_content", value: "Аврора анализирует сайты." }],
    entities: [], relations: [],
  },
};

describe("site analysis immutable snapshot exports", () => {
  it("renders all six formats from one snapshot and protects spreadsheet cells", async () => {
    const snapshot = buildSiteAnalysisExportSnapshot({
      analysisId: 41,
      runRevision: 2,
      requestId: "req-41",
      targetUrl: "https://example.com/",
      confirmedDomain: "example.com",
      exportedAt: "2026-08-05T12:00:00Z",
      result,
    });
    const rendered = Object.fromEntries(await Promise.all(
      ["csv", "xlsx", "json", "pdf", "html", "markdown"].map(async (format) => [format, await renderSiteAnalysisExport(format, snapshot)]),
    ));
    expect(rendered.csv.bytes.subarray(0, 3).toString("hex")).toBe("efbbbf");
    expect(rendered.csv.bytes.toString("utf8")).toContain("'=Аврора");
    expect(rendered.xlsx.bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(JSON.parse(rendered.json.bytes.toString("utf8")).analysis.snapshotHash).toBe(`sha256:${"a".repeat(64)}`);
    expect(rendered.pdf.bytes.subarray(0, 4).toString()).toBe("%PDF");
    expect(rendered.html.bytes.toString("utf8")).toContain("OSINT-интервью");
    expect(rendered.markdown.bytes.toString("utf8")).toContain("organization.identity");
  });
});
