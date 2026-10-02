// Оркестратор исследования интернета. Связывает четыре шага:
//   план запросов → поиск → чтение страниц → извлечение фактов → ворота достоверности.
//
// Модуль намеренно не знает ни про Postgres, ни про Redis, ни про конкретный
// AI-провайдер: всё внешнее приходит через `deps`. Благодаря этому полный цикл
// «нашёл → прочитал → проверил цитату» проверяется тестом без сети.
//
// Ключевое свойство: страница, не прошедшая ворота, не исчезает. Она попадает в
// журнал с кодом отказа — именно это видит пользователь в «полном логе исследования».

import { evaluateWebFinding, normalizeForMatch, sourceTextFromHtml, WEB_FINDING_REJECTION_LABELS } from "./web-research-contract.mjs";
import { planWebResearch, scoreWebResearchCandidate, normalizeWebResearchBudget } from "./web-research-plan.mjs";
import { resolveWebSource } from "./web-research-sources.mjs";

export const WEB_RESEARCH_LOG_LIMIT = 60;

export class WebResearchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WebResearchError";
    this.code = code;
  }
}

/** Проверяет, что ссылку вообще можно открывать: только публичный http(s). */
export function isReadableResearchUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (!host.includes(".")) return false;
    if (/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/u.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function cleanText(value, limit) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
}

/**
 * Отбирает страницы для чтения: сначала самые релевантные, по одной на домен,
 * в пределах бюджета. Дубли по домену отбрасываются, чтобы один сайт
 * не съел весь бюджет запросов.
 */
export function selectResearchPages(candidates, plan, options = {}) {
  const maxPages = Number(options.maxPages ?? plan?.budget?.maxPages ?? 12);
  const perDomain = Math.max(1, Number(options.perDomain ?? 2));
  const scored = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const url = String(candidate?.url ?? "").trim();
    if (!url || seen.has(url) || !isReadableResearchUrl(url)) continue;
    const source = resolveWebSource(url);
    if (source.nonSource) continue;
    seen.add(url);
    scored.push({
      url,
      domain: source.domain,
      title: cleanText(candidate?.title, 240),
      snippet: cleanText(candidate?.snippet, 600),
      publishedAt: candidate?.publishedAt ? String(candidate.publishedAt) : null,
      tier: source.tier,
      trust: source.trust,
      score: scoreWebResearchCandidate(candidate, plan),
      matchedQueries: Array.isArray(candidate?.matchedQueries) ? candidate.matchedQueries.slice(0, 6) : [],
    });
  }
  scored.sort((left, right) => right.score - left.score || right.trust - left.trust);
  const perDomainCount = new Map();
  const selected = [];
  for (const page of scored) {
    const used = perDomainCount.get(page.domain) || 0;
    if (used >= perDomain) continue;
    perDomainCount.set(page.domain, used + 1);
    selected.push(page);
    if (selected.length >= maxPages) break;
  }
  return selected;
}

function createBudget(input) {
  const limits = normalizeWebResearchBudget(input);
  const startedAt = Date.now();
  return {
    limits,
    startedAt,
    queriesUsed: 0,
    pagesUsed: 0,
    spentMs: () => Date.now() - startedAt,
    expired: () => Date.now() - startedAt >= limits.deadlineMs,
    takeQuery() {
      if (this.queriesUsed >= limits.maxQueries || this.expired()) return false;
      this.queriesUsed += 1;
      return true;
    },
    takePage() {
      if (this.pagesUsed >= limits.maxPages || this.expired()) return false;
      this.pagesUsed += 1;
      return true;
    },
  };
}

/**
 * Полный цикл исследования.
 *
 * @param {object} request
 * @param {string} [request.topic]
 * @param {string[]} [request.categories]
 * @param {"RU"|"EN"|"ANY"} [request.language]
 * @param {string[]} [request.extraQueries]
 * @param {object} [request.budget]
 * @param {object} deps
 * @param {(query: string, plan: object) => Promise<Array<object>>} deps.search
 * @param {(url: string) => Promise<{ url?: string, text?: string, html?: string, contentType?: string, status?: number }>} deps.fetchPage
 * @param {(input: { page: object, plan: object, pageText: string }) => Promise<Array<object>>} deps.extract
 * @param {number} [deps.now]
 * @param {(message: string, detail?: object) => void} [deps.onLog]
 */
export async function runWebResearch(request = {}, deps = {}) {
  if (typeof deps.search !== "function") throw new WebResearchError("no_search", "Не задан поисковый провайдер");
  if (typeof deps.fetchPage !== "function") throw new WebResearchError("no_fetch", "Не задан загрузчик страниц");
  if (typeof deps.extract !== "function") throw new WebResearchError("no_extract", "Не задан извлекатель фактов");

  const now = Number(deps.now) || Date.now();
  const plan = planWebResearch(request, {});
  const budget = createBudget(plan.budget);
  const log = [];
  const findings = [];
  const rejections = [];
  const seenFingerprints = new Set();
  const seenClaims = new Set();
  const note = (step, message, detail) => {
    log.push({ step, message, detail: detail || null, at: new Date().toISOString() });
    if (log.length > WEB_RESEARCH_LOG_LIMIT) log.shift();
    if (typeof deps.onLog === "function") deps.onLog(message, detail);
  };

  note("plan", `План: ${plan.queries.length} запросов, ${plan.siteScopedCount} с привязкой к первоисточникам`, {
    topic: plan.topic,
    categories: plan.categories,
  });

  // ── Шаг 1. Поиск ───────────────────────────────────────────────────────────────
  const candidates = [];
  for (const query of plan.queries) {
    if (!budget.takeQuery()) {
      note("search", "Бюджет запросов исчерпан", { queriesUsed: budget.queriesUsed });
      break;
    }
    if (budget.expired()) {
      note("search", "Истёк общий дедлайн исследования", { spentMs: budget.spentMs() });
      break;
    }
    try {
      const results = await deps.search(query.text, plan);
      const list = Array.isArray(results) ? results : [];
      note("search", `«${query.text}» → ${list.length} результатов`, { queryId: query.id, siteScoped: query.siteScoped });
      for (const item of list) {
        candidates.push({ ...item, matchedQueries: [...(item.matchedQueries || []), query.text] });
      }
    } catch (error) {
      note("search", `Поиск не ответил: ${cleanText(error?.message, 200) || "неизвестная ошибка"}`, { queryId: query.id });
    }
  }
  note("search", `Всего кандидатов: ${candidates.length}`, { candidates: candidates.length });

  // ── Шаг 2. Отбор страниц под бюджет ────────────────────────────────────────────
  const pages = selectResearchPages(candidates, plan, { maxPages: budget.limits.maxPages });
  note("select", `К чтению отобрано ${pages.length} страниц из ${candidates.length}`, {
    dropped: Math.max(0, candidates.length - pages.length),
  });

  // ── Шаг 3. Чтение и извлечение фактов ──────────────────────────────────────────
  for (const page of pages) {
    if (!budget.takePage()) {
      note("read", "Бюджет чтения страниц исчерпан", { pagesUsed: budget.pagesUsed });
      break;
    }
    let response;
    try {
      response = await deps.fetchPage(page.url);
    } catch (error) {
      const code = cleanText(error?.code, 60) || "fetch_failed";
      rejections.push({ url: page.url, domain: page.domain, code, reason: cleanText(error?.message, 240) || "Страница не загрузилась" });
      note("read", `Не удалось прочитать ${page.domain}: ${code}`, { url: page.url });
      continue;
    }
    const raw = String(response?.html ?? response?.text ?? "");
    const contentType = String(response?.contentType ?? "");
    if (contentType && !/text\/html|text\/plain|application\/xhtml|application\/xml|application\/rss|text\/xml/iu.test(contentType)) {
      rejections.push({ url: page.url, domain: page.domain, code: "unsupported_content_type", reason: `Тип содержимого ${cleanText(contentType, 80)} не является текстом` });
      note("read", `Пропуск ${page.domain}: не текст (${cleanText(contentType, 60)})`, { url: page.url });
      continue;
    }
    const pageText = sourceTextFromHtml(raw);
    note("read", `Прочитано ${page.domain}: ${pageText.length} символов`, { url: page.url, characters: pageText.length });

    let extracted;
    try {
      extracted = await deps.extract({ page, plan, pageText });
    } catch (error) {
      rejections.push({ url: page.url, domain: page.domain, code: "extract_failed", reason: cleanText(error?.message, 240) || "Извлечение не удалось" });
      note("extract", `Извлечение не удалось на ${page.domain}`, { url: page.url });
      continue;
    }
    const drafts = Array.isArray(extracted) ? extracted : [];
    if (!drafts.length) {
      rejections.push({ url: page.url, domain: page.domain, code: "no_facts", reason: "На странице не найдено утверждений по теме" });
      note("extract", `На ${page.domain} не найдено фактов по теме`, { url: page.url });
      continue;
    }

    // ── Шаг 4. Ворота достоверности ─────────────────────────────────────────────
    for (const draft of drafts) {
      const draftLanguage = draft?.language === "EN" || draft?.language === "RU" ? draft.language : null;
      const result = evaluateWebFinding({
        kind: draft?.kind,
        claim: draft?.claim,
        quote: draft?.quote,
        sourceUrl: response?.url || page.url,
        sourceText: pageText,
        publishedAt: draft?.publishedAt || page.publishedAt,
        legalStatus: draft?.legalStatus,
        title: draft?.title || page.title,
        language: draftLanguage || (plan.language === "EN" ? "EN" : "RU"),
        corroborating: draft?.corroborating,
        now,
      });
      if (!result.ok) {
        rejections.push({
          url: page.url,
          domain: page.domain,
          code: result.code,
          reason: result.reason || WEB_FINDING_REJECTION_LABELS[result.code] || result.code,
          detail: result.detail || null,
          claim: cleanText(draft?.claim, 240),
        });
        note("gate", `Отклонено на ${page.domain}: ${result.reason}`, { url: page.url, code: result.code });
        continue;
      }
      // Дедупликация по смыслу утверждения, а не по полному отпечатку: один и тот же
      // факт, пересказанный двумя сайтами, должен дать одну карточку. Подтверждение
      // вторым источником подхватывает нижележащий слой сигналов, который складывает
      // URL в market_signal_sources.
      const claimKey = `${result.finding.kind}:${normalizeForMatch(result.finding.claim)}`;
      if (seenFingerprints.has(result.finding.fingerprint) || seenClaims.has(claimKey)) {
        note("gate", `Дубль факта пропущен: ${cleanText(result.finding.claim, 120)}`, { url: page.url });
        continue;
      }
      seenFingerprints.add(result.finding.fingerprint);
      seenClaims.add(claimKey);
      findings.push({ ...result.finding, matchedQueries: page.matchedQueries, candidateScore: page.score });
      note("gate", `Принят факт: ${cleanText(result.finding.claim, 140)}`, { url: page.url, tier: result.finding.source.tier });
    }
  }

  findings.sort((left, right) => right.source.trust - left.source.trust || right.candidateScore - left.candidateScore);

  return {
    plan,
    findings,
    rejections,
    log,
    stats: {
      queries: budget.queriesUsed,
      pages: budget.pagesUsed,
      candidates: candidates.length,
      findings: findings.length,
      rejections: rejections.length,
      spentMs: budget.spentMs(),
      deadlineHit: budget.expired(),
    },
  };
}

/**
 * Сводка журнала для интерфейса: пользователь должен видеть, что именно Аврора
 * искала, что прочитала и почему отбросила остальное.
 */
export function summarizeWebResearchRun(run) {
  const rejectionsByCode = new Map();
  for (const rejection of Array.isArray(run?.rejections) ? run.rejections : []) {
    const code = String(rejection?.code ?? "unknown");
    rejectionsByCode.set(code, (rejectionsByCode.get(code) || 0) + 1);
  }
  const topReasons = [...rejectionsByCode.entries()]
    .map(([code, count]) => ({ code, count, reason: WEB_FINDING_REJECTION_LABELS[code] || code }))
    .sort((left, right) => right.count - left.count);
  return {
    queries: Number(run?.stats?.queries) || 0,
    pages: Number(run?.stats?.pages) || 0,
    candidates: Number(run?.stats?.candidates) || 0,
    findings: Array.isArray(run?.findings) ? run.findings.length : 0,
    rejections: Array.isArray(run?.rejections) ? run.rejections.length : 0,
    spentMs: Number(run?.stats?.spentMs) || 0,
    deadlineHit: run?.stats?.deadlineHit === true,
    rejectionsByCode: topReasons,
  };
}

/** Готовая строка «почему это повод» — одинаковая во всех фичах. */
export function webFindingAngle(finding) {
  if (!finding) return "";
  const source = finding.source?.label || finding.source?.domain || "источник";
  const parts = [];
  if (finding.kind === "law" && finding.legalStatusLabel) parts.push(finding.legalStatusLabel);
  parts.push(finding.claim);
  parts.push(`Источник: ${source}`);
  return parts.join(". ").slice(0, 600);
}
