import { createRequire } from "node:module";

import { renderTabularXlsx, resolveLibraryPdfFontPath } from "../library-export.mjs";
import { SITE_INTERVIEW_CATEGORIES, SITE_INTERVIEW_QUESTIONS } from "./questions.data.mjs";

export const SITE_ANALYSIS_EXPORT_FORMATS = Object.freeze(["csv", "xlsx", "json", "pdf", "html", "markdown"]);

const require = createRequire(import.meta.url);
const questionById = new Map(SITE_INTERVIEW_QUESTIONS.map((question) => [question.id, question]));
const categoryById = new Map(SITE_INTERVIEW_CATEGORIES.map((category) => [category.id, category]));

function clean(value, max = 20_000) {
  return String(value ?? "").replace(/\u0000/gu, "").trim().slice(0, max);
}
function safeCell(value) {
  const result = clean(value);
  return /^[=+\-@]/u.test(result) ? `'${result}` : result;
}

function sourceLinks(answer, evidenceById, sourceById) {
  const ids = new Set([
    ...(answer.evidenceIds || []),
    ...(answer.facts || []).flatMap((fact) => fact.evidenceIds || []),
    ...(answer.contradictions || []).flatMap((item) => item.evidenceIds || []),
  ]);
  return [...new Set([...ids].map((id) => {
    const evidence = evidenceById.get(id);
    return evidence ? sourceById.get(evidence.sourceId)?.url : null;
  }).filter(Boolean))];
}

export function buildSiteAnalysisExportSnapshot(input) {
  const result = input?.result || {};
  const osint = result.osint;
  const evidenceSnapshot = result.snapshot || {};
  if (!osint || osint.reportStatus !== "complete" || !Array.isArray(osint.answers)) {
    throw new TypeError("site_analysis_export_not_ready");
  }
  const evidenceById = new Map((evidenceSnapshot.evidence || []).map((item) => [item.id, item]));
  const sourceById = new Map((evidenceSnapshot.sources || []).map((item) => [item.id, item]));
  const answers = osint.answers.map((answer) => {
    const question = questionById.get(answer.questionId);
    const category = categoryById.get(question?.category);
    return {
      category: category?.title || question?.category || "",
      questionId: answer.questionId,
      question: question?.question || answer.questionId,
      status: answer.status,
      confidence: answer.confidence,
      shortAnswer: answer.shortAnswer,
      explanation: answer.explanation,
      facts: (answer.facts || []).map((fact) => fact.statement),
      gaps: answer.gaps || [],
      requiredIntegrations: answer.requiredIntegrations || [],
      evidenceIds: answer.evidenceIds || [],
      sourceUrls: sourceLinks(answer, evidenceById, sourceById),
      recommendationHooks: answer.recommendationHooks || [],
    };
  });
  return Object.freeze({
    exportedAt: new Date(input?.exportedAt || Date.now()).toISOString(),
    analysis: Object.freeze({
      id: Number(input?.analysisId),
      runRevision: Number(input?.runRevision),
      requestId: clean(input?.requestId, 128),
      targetUrl: clean(input?.targetUrl, 2_000),
      confirmedDomain: clean(input?.confirmedDomain, 253),
      completedAt: input?.completedAt ? new Date(input.completedAt).toISOString() : null,
      coverageMode: osint.coverage?.mode || evidenceSnapshot.coverage?.mode || "site_only",
      promptVersion: osint.promptVersion || null,
      questionCatalogVersion: osint.questionCatalogVersion || null,
      snapshotHash: osint.snapshotHash || evidenceSnapshot.snapshotHash || null,
    }),
    summary: osint.summary,
    answers: Object.freeze(answers),
    sources: Object.freeze(evidenceSnapshot.sources || []),
    evidence: Object.freeze(evidenceSnapshot.evidence || []),
    entities: Object.freeze(evidenceSnapshot.entities || []),
    relations: Object.freeze(evidenceSnapshot.relations || []),
    recommendations: Object.freeze(osint.recommendations || []),
    marketingPlan: osint.marketingPlan || null,
  });
}

const HEADERS = Object.freeze([
  ["category", "Раздел"],
  ["questionId", "ID вопроса"],
  ["question", "Вопрос"],
  ["status", "Статус"],
  ["confidence", "Уверенность"],
  ["shortAnswer", "Краткий ответ"],
  ["explanation", "Объяснение"],
  ["facts", "Факты"],
  ["gaps", "Пробелы"],
  ["requiredIntegrations", "Нужные интеграции"],
  ["sourceUrls", "Источники"],
]);

function value(answer, key) {
  const raw = answer?.[key];
  return Array.isArray(raw)
    ? raw.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(" | ")
    : safeCell(raw);
}

function rows(snapshot) {
  return [
    ["Дата экспорта", snapshot.exportedAt],
    ["Анализ", snapshot.analysis.id],
    ["Ревизия", snapshot.analysis.runRevision],
    ["URL", snapshot.analysis.targetUrl],
    ["Покрытие", snapshot.analysis.coverageMode],
    ["Версия промпта", snapshot.analysis.promptVersion || ""],
    ["Версия вопросов", snapshot.analysis.questionCatalogVersion || ""],
    ["Hash среза", snapshot.analysis.snapshotHash || ""],
    [],
    HEADERS.map(([, label]) => label),
    ...snapshot.answers.map((answer) => HEADERS.map(([key]) => value(answer, key))),
  ];
}

function csvCell(value) {
  const content = safeCell(value).replace(/"/gu, '""');
  return `"${content}"`;
}

function escapeHtml(value) {
  return clean(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

function markdown(value) {
  return clean(value).replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, "<br>");
}

export function renderSiteAnalysisCsv(snapshot) {
  return Buffer.from(`\uFEFF${rows(snapshot).map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`, "utf8");
}

export function renderSiteAnalysisJson(snapshot) {
  return Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

export function renderSiteAnalysisHtml(snapshot) {
  const answerRows = snapshot.answers.map((answer) => `<tr>${HEADERS.map(([key]) => `<td>${escapeHtml(value(answer, key))}</td>`).join("")}</tr>`).join("");
  return Buffer.from(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>OSINT-интервью — ${escapeHtml(snapshot.analysis.confirmedDomain)}</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#172b4d}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{border:1px solid #d7dce5;padding:8px;text-align:start;vertical-align:top}th{background:#f4f6f9}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}dt{font-weight:700}dd{margin:0}</style></head><body><h1>OSINT-интервью сайта</h1><dl><dt>Сайт</dt><dd>${escapeHtml(snapshot.analysis.targetUrl)}</dd><dt>Дата экспорта</dt><dd>${escapeHtml(snapshot.exportedAt)}</dd><dt>Покрытие</dt><dd>${escapeHtml(snapshot.analysis.coverageMode)}</dd><dt>Hash среза</dt><dd>${escapeHtml(snapshot.analysis.snapshotHash)}</dd></dl><table><thead><tr>${HEADERS.map(([, label]) => `<th scope="col">${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${answerRows}</tbody></table></body></html>`, "utf8");
}

export function renderSiteAnalysisMarkdown(snapshot) {
  const header = `| ${HEADERS.map(([, label]) => markdown(label)).join(" | ")} |`;
  const separator = `| ${HEADERS.map(() => "---").join(" | ")} |`;
  const body = snapshot.answers.map((answer) => `| ${HEADERS.map(([key]) => markdown(value(answer, key))).join(" | ")} |`).join("\n");
  return Buffer.from(`# OSINT-интервью сайта\n\n- **Сайт:** ${markdown(snapshot.analysis.targetUrl)}\n- **Дата экспорта:** ${markdown(snapshot.exportedAt)}\n- **Покрытие:** ${markdown(snapshot.analysis.coverageMode)}\n- **Hash среза:** ${markdown(snapshot.analysis.snapshotHash)}\n\n${header}\n${separator}\n${body}\n`, "utf8");
}

export async function renderSiteAnalysisPdf(snapshot) {
  const PDFDocument = require("pdfkit");
  const document = new PDFDocument({ size: "A4", margin: 36, info: { Title: "OSINT-интервью сайта" } });
  const chunks = [];
  document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise((resolve, reject) => {
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });
  document.registerFont("Aurora", resolveLibraryPdfFontPath());
  document.font("Aurora").fontSize(17).text("OSINT-интервью сайта");
  document.moveDown(0.4).fontSize(8.5).fillColor("#475569");
  document.text(`Сайт: ${snapshot.analysis.targetUrl}`);
  document.text(`Дата экспорта: ${snapshot.exportedAt}`);
  document.text(`Покрытие: ${snapshot.analysis.coverageMode}`);
  document.text(`Hash среза: ${snapshot.analysis.snapshotHash || "—"}`);
  document.fillColor("#172b4d");
  for (const answer of snapshot.answers) {
    if (document.y > document.page.height - 190) document.addPage();
    document.moveDown(0.8).fontSize(10.5).text(answer.question, { continued: false });
    document.fontSize(8).fillColor("#475569").text(`${answer.status} · ${answer.confidence} · ${answer.questionId}`);
    document.fillColor("#172b4d").fontSize(9).text(answer.shortAnswer);
    document.fontSize(8).text(answer.explanation);
    for (const url of answer.sourceUrls) document.fillColor("#2563ff").text(url, { link: url, underline: true });
    document.fillColor("#172b4d");
  }
  document.end();
  return done;
}

export async function renderSiteAnalysisExport(format, snapshot) {
  switch (format) {
    case "csv": return { bytes: renderSiteAnalysisCsv(snapshot), contentType: "text/csv; charset=utf-8", extension: "csv" };
    case "xlsx": return { bytes: renderTabularXlsx(rows(snapshot), "OSINT-интервью"), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" };
    case "json": return { bytes: renderSiteAnalysisJson(snapshot), contentType: "application/json; charset=utf-8", extension: "json" };
    case "pdf": return { bytes: await renderSiteAnalysisPdf(snapshot), contentType: "application/pdf", extension: "pdf" };
    case "html": return { bytes: renderSiteAnalysisHtml(snapshot), contentType: "text/html; charset=utf-8", extension: "html" };
    case "markdown": return { bytes: renderSiteAnalysisMarkdown(snapshot), contentType: "text/markdown; charset=utf-8", extension: "md" };
    default: throw new TypeError("unsupported_site_analysis_export_format");
  }
}
