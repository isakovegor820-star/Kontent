import { createRequire } from "node:module";

import { resolveLibraryPdfFontPath } from "../library-export.mjs";

export const SITE_REPORT_EXPORT_FORMATS = Object.freeze(["json", "markdown", "html", "pdf"]);

const require = createRequire(import.meta.url);

const KIND_TITLES = Object.freeze({
  initial_audit: "Стартовый аудит сайта",
  monthly: "Ежемесячный отчёт по сайту",
  on_demand: "Отчёт по сайту",
});

const SOURCE_LABELS = Object.freeze({ seo: "SEO", geo: "GEO", content: "Контент" });

function clean(value, max = 20_000) {
  return String(value ?? "").replace(/\u0000/gu, "").trim().slice(0, max);
}

function escapeHtml(value) {
  return clean(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

function markdownCell(value) {
  return clean(value).replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

function score(value) {
  return value === null || value === undefined ? "—" : `${value}/100`;
}

function date(value) {
  return value ? clean(value).slice(0, 10) : "—";
}

/** Единая структура секций для всех форматов, чтобы Markdown, HTML и PDF не расходились. */
export function buildSiteReportSections(report) {
  const payload = report?.payload || {};
  const seo = payload.seo || {};
  const geo = payload.geo || {};
  const aeo = payload.aeo || {};
  const content = payload.content || {};
  const topics = content.topics || {};
  const sections = [];

  sections.push({
    title: "Сводка",
    paragraphs: [clean(report?.summaryRu)],
    facts: [
      ["Сайт", payload.site?.domain || ""],
      ["Домен подтверждён", payload.site?.verified ? "да" : "нет"],
      ["Дата отчёта", date(payload.generatedAt)],
      ["Версия отчёта", payload.reportVersion || ""],
      ["Ревизия анализа", payload.analysis?.runRevision ?? "—"],
    ],
  });

  const interpretation = report?.interpretation;
  if (interpretation && typeof interpretation === "object" && interpretation.summary) {
    sections.push({
      title: "Интерпретация Авроры",
      paragraphs: [clean(interpretation.summary)],
      bullets: [
        ...(Array.isArray(interpretation.whatItMeans) ? interpretation.whatItMeans.map((item) => clean(item)) : []),
      ],
      table: Array.isArray(interpretation.startWith) && interpretation.startWith.length
        ? {
            headers: ["С чего начать", "Почему"],
            rows: interpretation.startWith.map((item) => [item.title || item.key, item.why]),
            empty: "",
          }
        : undefined,
      footnote: [
        ...(Array.isArray(interpretation.watchOut) && interpretation.watchOut.length ? [`Ограничения: ${interpretation.watchOut.map((item) => clean(item)).join(" ")}`] : []),
        clean(interpretation.disclaimer),
      ].filter(Boolean).join(" "),
    });
  }

  sections.push({
    title: "SEO (on-page)",
    facts: [
      ["Оценка", score(seo.score)],
      ["Проверено страниц", seo.pagesChecked ?? "—"],
      ["Недоступных страниц", seo.failedPages ?? "—"],
      ["Страниц без входящих ссылок", seo.orphanCandidates ?? "—"],
      ["Нужны интеграции", (seo.requiredIntegrations || []).join(", ") || "—"],
    ],
    table: {
      headers: ["Проверка", "Статус", "Что найдено", "Что сделать"],
      rows: (seo.issues || []).map((issue) => [issue.label, issue.status, issue.detail, issue.recommendation]),
      empty: "Критичных и предупреждающих проверок нет.",
    },
  });

  const probe = geo.probe || {};
  const probeFacts = probe.status === "answered"
    ? [
        ["Зонд видимости", `прогон ${probe.runKey || "—"}, движков: ${(probe.engines || []).length}`],
        ["Вопросов ниши", probe.questions ?? "—"],
        ["Бренд упомянут", `${probe.brandMentioned ?? 0}${probe.deltaVsPrevious?.brandMentioned ? ` (${probe.deltaVsPrevious.brandMentioned})` : ""}`],
        ["Сайт процитирован", `${probe.siteCited ?? 0}${probe.deltaVsPrevious?.siteCited ? ` (${probe.deltaVsPrevious.siteCited})` : ""}`],
        ["Кого называют вместо вас", (probe.competitorsTop || []).map((item) => `${item.name} (${item.mentions})`).join(", ") || "—"],
      ]
    : [["Зонд видимости", probe.status === "skipped_budget" ? "пропущен: лимит ИИ" : probe.status === "failed" ? "не удался" : "не запускался"]];
  sections.push({
    title: "GEO (генеративный поиск)",
    facts: [
      ["Оценка готовности", score(geo.score)],
      ...probeFacts,
    ],
    table: {
      headers: ["Проверка", "Статус", "Что найдено", "Что сделать"],
      rows: (geo.issues || []).map((issue) => [issue.label, issue.status, issue.detail, issue.recommendation]),
      empty: "Замечаний по готовности к генеративному поиску нет.",
    },
  });

  sections.push({
    title: "AEO (быстрые ответы)",
    facts: [
      ["Страниц с вопросами", aeo.pagesWithQuestions ?? 0],
      ["Из них с полноценным ответом", aeo.answerPages ?? 0],
      ["Страниц с FAQPage", aeo.faqSchemaPages ?? 0],
      ["Вопросов без ответа", aeo.questionsWithoutAnswer ?? 0],
    ],
  });

  sections.push({
    title: "Контент и темы",
    facts: [
      ["Страниц в срезе", content.pageCount ?? 0],
      ["Публикаций", content.publicationCount ?? 0],
      ["Последняя публикация", date(content.lastPublishedAt)],
      ["Тем всего / глубоко / поверхностно", `${topics.total ?? 0} / ${topics.strong ?? 0} / ${topics.thin ?? 0}`],
      ["Страниц для перелинковки", content.linkablePages ?? 0],
    ],
    table: {
      headers: ["Тема", "Страниц", "Покрытие"],
      rows: (topics.items || []).map((topic) => [topic.label, topic.pageCount, topic.coverage]),
      empty: "Устойчивых тем не найдено.",
    },
  });

  if (payload.publications) {
    const publications = payload.publications;
    sections.push({
      title: "Публикации за период",
      facts: [
        ["Опубликовано", publications.published ?? 0],
        ["По типам", Object.entries(publications.byType || {}).map(([type, count]) => `${type}: ${count}`).join(", ") || "—"],
        ["Отклонено как дубли", publications.rejectedDuplicates ?? 0],
        ["Ждут одобрения", publications.pendingReview ?? 0],
        ["Не удалось опубликовать", publications.failed ?? 0],
      ],
    });
  }

  sections.push({
    title: "Пробелы",
    table: {
      headers: ["Пробел", "Важность", "Пояснение"],
      rows: (content.gaps || []).map((gap) => [gap.label, gap.severity, gap.detail]),
      empty: "Пробелов не найдено.",
    },
  });

  sections.push({
    title: "Рекомендации",
    table: {
      headers: ["Приоритет", "Источник", "Рекомендация", "Основание", "Статус"],
      rows: (payload.recommendations || []).map((item) => [item.priority, SOURCE_LABELS[item.source] || item.source, item.title, item.rationale, item.status]),
      empty: "Рекомендаций нет.",
    },
  });

  sections.push({
    title: "Ограничения",
    bullets: [...(payload.limitations || [])],
  });

  return sections;
}

export function renderSiteReportJson(report) {
  return Buffer.from(`${JSON.stringify({ summaryRu: report.summaryRu, interpretation: report.interpretation ?? null, ...report.payload }, null, 2)}\n`, "utf8");
}

export function renderSiteReportMarkdown(report) {
  const title = KIND_TITLES[report?.payload?.kind] || KIND_TITLES.on_demand;
  const lines = [`# ${title} — ${markdownCell(report?.payload?.site?.domain)}`, ""];
  for (const section of buildSiteReportSections(report)) {
    lines.push(`## ${section.title}`, "");
    for (const paragraph of section.paragraphs || []) lines.push(paragraph, "");
    for (const [label, value] of section.facts || []) lines.push(`- **${markdownCell(label)}:** ${markdownCell(value)}`);
    if (section.facts?.length) lines.push("");
    for (const bullet of section.bullets || []) lines.push(`- ${markdownCell(bullet)}`);
    if (section.bullets?.length) lines.push("");
    if (section.footnote) lines.push(`_${markdownCell(section.footnote)}_`, "");
    if (section.table) {
      if (!section.table.rows.length) {
        lines.push(section.table.empty, "");
      } else {
        lines.push(`| ${section.table.headers.map(markdownCell).join(" | ")} |`);
        lines.push(`| ${section.table.headers.map(() => "---").join(" | ")} |`);
        for (const row of section.table.rows) lines.push(`| ${row.map(markdownCell).join(" | ")} |`);
        lines.push("");
      }
    }
  }
  return Buffer.from(`${lines.join("\n").trimEnd()}\n`, "utf8");
}

export function renderSiteReportHtml(report) {
  const title = KIND_TITLES[report?.payload?.kind] || KIND_TITLES.on_demand;
  const domain = escapeHtml(report?.payload?.site?.domain);
  const body = buildSiteReportSections(report).map((section) => {
    const parts = [`<h2>${escapeHtml(section.title)}</h2>`];
    for (const paragraph of section.paragraphs || []) parts.push(`<p>${escapeHtml(paragraph)}</p>`);
    if (section.facts?.length) {
      parts.push(`<dl>${section.facts.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`);
    }
    if (section.bullets?.length) parts.push(`<ul>${section.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    if (section.footnote) parts.push(`<p class="muted">${escapeHtml(section.footnote)}</p>`);
    if (section.table) {
      if (!section.table.rows.length) parts.push(`<p class="muted">${escapeHtml(section.table.empty)}</p>`);
      else {
        parts.push(`<table><thead><tr>${section.table.headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${section.table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      }
    }
    return parts.join("");
  }).join("");
  return Buffer.from(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(title)} — ${domain}</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#172b4d;max-width:1100px}h1{font-size:22px}h2{font-size:16px;margin-top:28px}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border:1px solid #d7dce5;padding:8px;text-align:start;vertical-align:top}th{background:#f4f6f9}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}dt{font-weight:700}dd{margin:0}.muted{color:#64748b}</style></head><body><h1>${escapeHtml(title)} — ${domain}</h1>${body}</body></html>`, "utf8");
}

export async function renderSiteReportPdf(report) {
  const PDFDocument = require("pdfkit");
  const title = KIND_TITLES[report?.payload?.kind] || KIND_TITLES.on_demand;
  const document = new PDFDocument({ size: "A4", margin: 36, info: { Title: title } });
  const chunks = [];
  document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise((resolve, reject) => {
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });
  const ensureSpace = (needed = 120) => {
    if (document.y > document.page.height - needed) document.addPage();
  };
  document.registerFont("Aurora", resolveLibraryPdfFontPath());
  document.font("Aurora").fontSize(17).fillColor("#172b4d").text(`${title} — ${clean(report?.payload?.site?.domain)}`);
  for (const section of buildSiteReportSections(report)) {
    ensureSpace(140);
    document.moveDown(0.9).fontSize(12).fillColor("#172b4d").text(section.title);
    for (const paragraph of section.paragraphs || []) {
      document.moveDown(0.3).fontSize(9).text(clean(paragraph));
    }
    for (const [label, value] of section.facts || []) {
      ensureSpace();
      document.fontSize(8.5).fillColor("#475569").text(`${clean(label)}: `, { continued: true }).fillColor("#172b4d").text(clean(value));
    }
    for (const bullet of section.bullets || []) {
      ensureSpace();
      document.fontSize(8.5).fillColor("#172b4d").text(`• ${clean(bullet)}`);
    }
    if (section.footnote) {
      ensureSpace();
      document.moveDown(0.2).fontSize(8).fillColor("#64748b").text(clean(section.footnote));
    }
    if (section.table) {
      if (!section.table.rows.length) {
        document.moveDown(0.2).fontSize(8.5).fillColor("#64748b").text(section.table.empty);
      }
      for (const row of section.table.rows) {
        ensureSpace();
        document.moveDown(0.35);
        section.table.headers.forEach((header, index) => {
          const value = clean(row[index]);
          if (!value) return;
          document.fontSize(8).fillColor("#475569").text(`${header}: `, { continued: true }).fillColor("#172b4d").text(value);
        });
      }
    }
  }
  document.end();
  return done;
}

export async function renderSiteReportExport(format, report) {
  switch (format) {
    case "json": return { bytes: renderSiteReportJson(report), contentType: "application/json; charset=utf-8", extension: "json" };
    case "markdown": return { bytes: renderSiteReportMarkdown(report), contentType: "text/markdown; charset=utf-8", extension: "md" };
    case "html": return { bytes: renderSiteReportHtml(report), contentType: "text/html; charset=utf-8", extension: "html" };
    case "pdf": return { bytes: await renderSiteReportPdf(report), contentType: "application/pdf", extension: "pdf" };
    default: throw new TypeError("unsupported_site_report_export_format");
  }
}
