import { createHash } from "node:crypto";

export const SITE_OSINT_SNAPSHOT_VERSION = "site-osint-snapshot-v1";

const SENSITIVE_QUERY = /^(?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret|code|cookie|credential|jwt|password|passwd|refresh[_-]?token|session(?:id)?|sid|signature|token)$/iu;
const TRACKING_QUERY = /^(?:utm_.+|fbclid|gclid|yclid)$/iu;
const INJECTION_SIGNAL = /(?:ignore (?:all |the )?(?:previous|above)|system prompt|developer message|reveal (?:the )?(?:prompt|secret)|выполни (?:эту|следующую) инструкц|игнорируй (?:все |предыдущие )?инструкц|раскрой (?:системный )?промпт)/iu;

function cleanText(value, max = 2_000) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

export function sanitizeEvidenceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(key) || TRACKING_QUERY.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function siteEvidenceHash(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableId(prefix, value) {
  return `${prefix}_${siteEvidenceHash(value).slice(0, 24)}`;
}

function pageCorpus(page) {
  return cleanText([
    page?.title,
    page?.description,
    ...(Array.isArray(page?.headings) ? page.headings.map((heading) => heading?.text) : []),
    page?.mainContent,
  ].filter(Boolean).join(" "), 30_000);
}

const PAGE_RULES = Object.freeze([
  ["home", (url) => url.pathname === "/"],
  ["team", (_url, text, schemas) => /(?:команд|сотрудник|руководств|эксперт|специалист|team|people|leadership)/iu.test(text) || schemas.has("Person")],
  ["case", (_url, text, schemas) => /(?:кейс|истори[яи] успех|результат|case stud|portfolio)/iu.test(text) || schemas.has("CaseStudy")],
  ["partner", (_url, text) => /(?:партн[её]р|клиент|интеграц|partner|client)/iu.test(text)],
  ["event", (_url, text, schemas) => /(?:мероприят|вебинар|конференц|событи|event|webinar)/iu.test(text) || schemas.has("Event")],
  ["product", (_url, text, schemas) => /(?:продукт|тариф|цены|стоимост|product|pricing|price)/iu.test(text) || schemas.has("Product")],
  ["service", (_url, text, schemas) => /(?:услуг|решени|service|practice)/iu.test(text) || schemas.has("Service")],
  ["contact", (_url, text) => /(?:контакт|связаться|contact)/iu.test(text)],
  ["about", (_url, text) => /(?:о компании|о нас|мисси|истори[яи] компании|about us)/iu.test(text)],
  ["article", (_url, text, schemas) => /(?:стать[яи]|новост|блог|исследован|article|news|blog)/iu.test(text) || schemas.has("Article") || schemas.has("NewsArticle")],
]);

export function classifySitePage(page) {
  const url = new URL(sanitizeEvidenceUrl(page?.url) || "https://invalid.local/");
  const text = cleanText(`${url.pathname} ${page?.title || ""} ${(page?.headings || []).map((heading) => heading?.text || "").join(" ")}`, 4_000);
  const schemas = new Set(Array.isArray(page?.schemaTypes) ? page.schemaTypes : []);
  for (const [kind, matches] of PAGE_RULES) if (matches(url, text, schemas)) return kind;
  return "other";
}

function sourceQuality(page) {
  if (Number(page?.status) < 200 || Number(page?.status) >= 400) return "unavailable";
  const words = Number(page?.technical?.wordCount || 0);
  if (words >= 300 && page?.title) return "high";
  if (words >= 80 || page?.title) return "medium";
  return "low";
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sourceForPage(page, checkedAt) {
  const url = sanitizeEvidenceUrl(page?.url);
  if (!url) return null;
  const kind = "owned_page";
  return Object.freeze({
    id: stableId("src", { kind, url }),
    kind,
    url,
    title: cleanText(page?.title || url, 500),
    pageType: classifySitePage(page),
    primary: true,
    checkedAt,
    publishedAt: normalizeDate(page?.metadata?.publishedAt),
    modifiedAt: normalizeDate(page?.metadata?.modifiedAt),
    quality: sourceQuality(page),
    contentHash: `sha256:${siteEvidenceHash({
      status: Number(page?.status || 0),
      title: cleanText(page?.title, 500),
      description: cleanText(page?.description, 1_000),
      headings: page?.headings || [],
      mainContent: cleanText(page?.mainContent, 20_000),
      schemaTypes: page?.schemaTypes || [],
      metadata: page?.metadata || {},
    })}`,
  });
}

function makeEvidence(source, type, value, options = {}) {
  const normalized = typeof value === "string" ? cleanText(value, options.maxLength || 2_000) : stableValue(value);
  if (normalized == null || normalized === "" || (Array.isArray(normalized) && normalized.length === 0)) return null;
  const fingerprint = { sourceId: source.id, type, value: normalized };
  return Object.freeze({
    id: stableId("ev", fingerprint),
    sourceId: source.id,
    sourceUrl: source.url,
    sourceTitle: source.title,
    type,
    value: normalized,
    factType: options.factType || "document",
    extractedBy: options.extractedBy || "deterministic",
    quality: options.quality || source.quality,
    currentness: options.currentness || (source.publishedAt || source.modifiedAt ? "dated" : "unknown"),
    checkedAt: source.checkedAt,
    publishedAt: source.publishedAt,
    untrustedContent: true,
    injectionSignal: typeof normalized === "string" && INJECTION_SIGNAL.test(normalized),
    hash: `sha256:${siteEvidenceHash(fingerprint)}`,
  });
}

function pageEvidence(page, source) {
  const result = [];
  const add = (type, value, options) => {
    const evidence = makeEvidence(source, type, value, options);
    if (evidence) result.push(evidence);
  };
  add("page_title", page?.title, { factType: "document", maxLength: 500 });
  add("page_description", page?.description, { factType: "document", maxLength: 1_000 });
  add("main_content", pageCorpus(page), { factType: "topic", maxLength: 4_000 });
  for (const heading of (page?.headings || []).slice(0, 40)) {
    add("heading", { level: Number(heading?.level || 0), text: cleanText(heading?.text, 500) }, { factType: "topic" });
  }
  add("schema_types", (page?.schemaTypes || []).slice(0, 50), { factType: "document" });
  for (const author of (page?.metadata?.authors || []).slice(0, 30)) add("author", author, { factType: "person", maxLength: 240 });
  if (page?.metadata?.publishedAt) add("published_at", String(page.metadata.publishedAt), { factType: "document" });
  if (page?.metadata?.modifiedAt) add("modified_at", String(page.metadata.modifiedAt), { factType: "document" });
  for (const cta of (page?.ctas || []).slice(0, 30)) add("cta", cta, { factType: "funnel", maxLength: 300 });
  for (const form of (page?.forms || []).slice(0, 20)) add("form", form, { factType: "funnel" });
  for (const comment of (page?.publicComments || []).slice(0, 20)) add("public_comment", comment, { factType: "reputation", maxLength: 500 });
  const technical = page?.technical && typeof page.technical === "object" ? page.technical : {};
  add("technical", technical, { factType: "technical" });
  for (const link of (page?.links || []).slice(0, 200)) {
    const linkUrl = sanitizeEvidenceUrl(link?.url);
    if (!linkUrl) continue;
    add(link?.kind === "external" ? "external_link" : "internal_link", {
      url: linkUrl,
      text: cleanText(link?.text, 300),
    }, { factType: "relation" });
  }
  return result;
}

function entityType(schemaTypes) {
  const types = new Set(Array.isArray(schemaTypes) ? schemaTypes : []);
  if (types.has("Person")) return "person";
  if (types.has("Product") || types.has("Service")) return "product";
  if (types.has("Event")) return "event";
  if (types.has("Organization") || types.has("Corporation") || types.has("LocalBusiness")) return "organization";
  if (types.has("Article") || types.has("NewsArticle")) return "document";
  return null;
}

function entityKey(type, name) {
  return `${type}:${cleanText(name, 300).toLocaleLowerCase("ru-RU")}`;
}

function buildEntities(domain, pages, sources, evidence) {
  const byUrl = new Map(sources.map((source) => [source.url, source]));
  const evidenceBySource = new Map();
  for (const item of evidence) {
    const bucket = evidenceBySource.get(item.sourceId) || [];
    bucket.push(item.id);
    evidenceBySource.set(item.sourceId, bucket);
  }
  const entities = new Map();
  const relations = new Map();
  const rootSource = sources.find((source) => new URL(source.url).pathname === "/") || sources[0];
  const rootName = cleanText(pages.find((page) => sanitizeEvidenceUrl(page?.url) === rootSource?.url)?.title || domain, 300);
  const rootKey = entityKey("organization", rootName || domain);
  const root = Object.freeze({
    id: stableId("ent", rootKey),
    type: "organization",
    canonicalKey: rootKey,
    name: rootName || domain,
    attributes: Object.freeze({ domain }),
    evidenceIds: Object.freeze((evidenceBySource.get(rootSource?.id) || []).slice(0, 10)),
    confidence: rootSource ? "medium" : "low",
  });
  entities.set(rootKey, root);

  for (const page of pages) {
    const source = byUrl.get(sanitizeEvidenceUrl(page?.url));
    if (!source) continue;
    for (const raw of (page?.metadata?.structuredEntities || []).slice(0, 100)) {
      const type = entityType(raw?.types);
      const name = cleanText(raw?.name, 300);
      if (!type || !name) continue;
      const key = entityKey(type, name);
      if (!entities.has(key)) {
        entities.set(key, Object.freeze({
          id: stableId("ent", key),
          type,
          canonicalKey: key,
          name,
          attributes: Object.freeze({
            schemaTypes: Object.freeze((raw?.types || []).slice(0, 10)),
            jobTitle: cleanText(raw?.jobTitle, 240) || null,
            url: sanitizeEvidenceUrl(raw?.url),
            sameAs: Object.freeze((raw?.sameAs || []).map(sanitizeEvidenceUrl).filter(Boolean).slice(0, 20)),
          }),
          evidenceIds: Object.freeze((evidenceBySource.get(source.id) || []).slice(0, 10)),
          confidence: "medium",
        }));
      }
      const entity = entities.get(key);
      if (entity.id === root.id) continue;
      const relationType = type === "person" ? "has_public_member"
        : type === "product" ? "offers"
          : type === "event" ? "participates_in"
            : type === "organization" ? "mentions_organization"
              : "publishes";
      const relationFingerprint = { from: root.id, to: entity.id, type: relationType, sourceId: source.id };
      const relation = Object.freeze({
        id: stableId("rel", relationFingerprint),
        fromEntityId: root.id,
        toEntityId: entity.id,
        type: relationType,
        status: relationType === "mentions_organization" ? "claimed" : "observed",
        validFrom: source.publishedAt,
        validTo: null,
        evidenceIds: Object.freeze((evidenceBySource.get(source.id) || []).slice(0, 10)),
        confidence: "medium",
      });
      relations.set(relation.id, relation);
    }
  }
  return { entities: [...entities.values()], relations: [...relations.values()] };
}

export function buildSiteEvidenceSnapshot(input) {
  const checkedAt = normalizeDate(input?.checkedAt) || new Date().toISOString();
  const domain = cleanText(input?.confirmedDomain, 253).toLowerCase();
  if (!domain) throw new TypeError("site evidence: confirmedDomain required");
  const pages = Array.isArray(input?.pages) ? input.pages : [];
  const sources = pages.map((page) => sourceForPage(page, checkedAt)).filter(Boolean);
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
  const evidence = [];
  const evidenceIds = new Set();
  for (const page of pages) {
    const source = sourceByUrl.get(sanitizeEvidenceUrl(page?.url));
    if (!source) continue;
    for (const item of pageEvidence(page, source)) {
      if (evidenceIds.has(item.id)) continue;
      evidenceIds.add(item.id);
      evidence.push(item);
    }
  }
  const graph = buildEntities(domain, pages, sources, evidence);
  const coverage = Object.freeze({
    mode: input?.coverageMode === "external" ? "external" : "site_only",
    confirmedDomain: domain,
    crawledAt: checkedAt,
    pageCount: sources.length,
    limitations: Object.freeze([
      ...(input?.coverageMode === "external" ? [] : ["Внешний OSINT-контур не запускался; покрытие ограничено подтверждённым доменом."]),
      "Публичный crawl не подтверждает посещаемость, конверсии, продажи, выручку или закрытые комментарии.",
    ]),
  });
  const withoutCheckedAt = (value) => {
    const copy = { ...value };
    delete copy.checkedAt;
    return copy;
  };
  const hashPayload = {
    version: SITE_OSINT_SNAPSHOT_VERSION,
    domain,
    coverageMode: coverage.mode,
    sources: sources.map(withoutCheckedAt).sort((left, right) => left.id.localeCompare(right.id)),
    evidence: evidence.map(withoutCheckedAt).sort((left, right) => left.id.localeCompare(right.id)),
    entities: graph.entities.slice().sort((left, right) => left.id.localeCompare(right.id)),
    relations: graph.relations.slice().sort((left, right) => left.id.localeCompare(right.id)),
  };
  const snapshotHash = `sha256:${siteEvidenceHash(hashPayload)}`;
  return Object.freeze({
    version: SITE_OSINT_SNAPSHOT_VERSION,
    snapshotHash,
    coverage,
    sources: Object.freeze(sources),
    evidence: Object.freeze(evidence),
    entities: Object.freeze(graph.entities),
    relations: Object.freeze(graph.relations),
  });
}
