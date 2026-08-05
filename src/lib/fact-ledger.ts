import { normalizePostSettings, type PostSettings } from "./post-settings";

export type FactLedgerPolicy = "closed_world" | "allow_general";
export type FactDomain = "general" | "legal" | "event" | "technology";

export interface FactEvidence {
  id: string;
  text: string;
  source: "brief" | "knowledge" | "required_fact" | "proof" | "profile";
  /** Инструктивный текст разрешает сущности, но не раздувает оценку доступного материала. */
  countsForCapacity?: boolean;
}

export interface FactRequirement {
  id: string;
  label: string;
  /** Любой вариант удовлетворяет требованию; это позволяет проверять безопасный paraphrase. */
  variants: string[];
}

export interface FactChoice {
  id: string;
  label: string;
  variants: string[];
}

export interface FactChoiceGroup {
  id: string;
  label: string;
  choices: FactChoice[];
  min: number;
  max: number;
}

export interface FactLedgerConstraints {
  maxEmoji?: number;
  maxHashtags?: number;
  minQuestions?: number;
  maxQuestions?: number;
  requireWhyQuestion?: boolean;
  cta?: "required" | "forbidden" | "any";
  ctaPhrases?: string[];
  forbidArtificialContrast?: boolean;
  forbidPromises?: boolean;
  forbidAdvice?: boolean;
  choiceGroups?: FactChoiceGroup[];
}

export interface FactLedger {
  version: 1;
  policy: FactLedgerPolicy;
  domain: FactDomain;
  evidence: FactEvidence[];
  required: FactRequirement[];
  requiredUrls: string[];
  forbiddenPhrases: string[];
  forbiddenClaims: FactRequirement[];
  constraints: FactLedgerConstraints;
  requestedMinChars?: number;
  requestedMaxChars?: number;
}

export interface FactPreflightIssue {
  code: "insufficient_grounded_material";
  message: string;
  requestedMinChars: number;
  estimatedGroundedChars: number;
  evidenceCount: number;
}

export interface FactPreflightResult {
  passed: boolean;
  issues: FactPreflightIssue[];
}

export interface FactualViolation {
  code:
    | "missing_required_fact"
    | "missing_required_url"
    | "unsupported_number"
    | "unsupported_date"
    | "unsupported_url"
    | "unsupported_legal_reference"
    | "unsupported_claim"
    | "unsupported_semantic_claim"
    | "forbidden_claim"
    | "forbidden_phrase"
    | "artificial_contrast"
    | "question_count"
    | "question_reason"
    | "emoji_limit"
    | "hashtag_limit"
    | "unexpected_cta"
    | "missing_cta"
    | "choice_count"
    | "promise"
    | "advice";
  message: string;
  blocker: true;
  evidenceId?: string;
}

export interface FactualValidationProvenance {
  validatorVersion: "fact-ledger-v1";
  ledgerHash: string;
  checkedAt: string;
  coverage: "deterministic" | "deterministic+semantic";
  semanticEntailment: "not_run" | "not_checked" | "passed" | "blocked";
  semanticAdapter?: string;
  rulesRun: string[];
  sourceIds: string[];
}

export interface FactualValidationResult {
  status: "passed" | "blocked" | "not_checked";
  passed: boolean;
  requiresReview: boolean;
  violations: FactualViolation[];
  provenance: FactualValidationProvenance;
}

const MONTHS = "январ(?:я|ь)|феврал(?:я|ь)|март(?:а)?|апрел(?:я|ь)|ма(?:я|й)|июн(?:я|ь)|июл(?:я|ь)|август(?:а)?|сентябр(?:я|ь)|октябр(?:я|ь)|ноябр(?:я|ь)|декабр(?:я|ь)";
const TEXT_DATE = new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})(?:\\s+\\d{4}(?:\\s+года?)?)?`, "giu");
const NUMERIC_DATE = /\b\d{1,2}[./-]\d{1,2}[./-](?:\d{2}|\d{4})\b/gu;
const URL = /https?:\/\/[^\s<>"'»]+/giu;
const LEGAL_REFERENCE = /(?:стать[ьяиюе]*|ст\.)\s*\d+(?:\.\d+)?\s*(?:[А-ЯA-ZЁ]{2,}(?:\s+[А-ЯA-ZЁ]{2,})*)?/giu;
const EMOJI = /\p{Extended_Pictographic}/gu;
const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;
const CTA = /(?:зарегистр\p{L}*|подпиш\p{L}*|напиш\p{L}*|ответ\p{L}*|переход\p{L}*|по\s+ссылке|остав\p{L}*\s+заявк|сохран\p{L}*|подел\p{L}*|скача\p{L}*|куп\p{L}*|попроб\p{L}*)/iu;
const PROMISE = /(?:гарантир\p{L}*|обеспеч\p{L}*\s+(?:точност|результат)|безошибоч\p{L}*|исключ\p{L}*\s+риск|сниж\p{L}*\s+риск|эконом\p{L}*\s+врем|ускор\p{L}*\s+работ)/iu;
const ADVICE = /(?:рекоменду\p{L}*|вам\s+следует|обязательно\s+обрат\p{L}*|нужно\s+подать|сделайте\s+так)/iu;
// JS \b опирается на ASCII \w даже с флагом u, поэтому для русских слов нужны
// явные Unicode-lookarounds.
const ARTIFICIAL_CONTRAST = /(?:(?<!\p{L})не\s+просто(?!\p{L})|(?<!\p{L})не\s+на\s+словах(?!\p{L})|(?<!\p{L})не\s+[^.!?\n]{1,80}\s+[—–-]\s+[^.!?\n]{1,80})/iu;
const CLAIM_MARKER = /(?:ежедневн\p{L}*|каждый\s+день|регулярн\p{L}*|гарантир\p{L}*|сниж\p{L}*|повыш\p{L}*|устраня\p{L}*|обеспеч\p{L}*|организатор\p{L}*|спикер\p{L}*|программ\p{L}*\s+включа\p{L}*|встреч\p{L}*\s+проход\p{L}*)/iu;

const NUMBER_WORDS: Array<[RegExp, string]> = [
  [/(?<!\p{L})(?:ноль|нул\p{L}*)(?!\p{L})/giu, "0"],
  [/(?<!\p{L})(?:один|одна|одно)(?!\p{L})/giu, "1"],
  [/(?<!\p{L})(?:два|две)(?!\p{L})/giu, "2"],
  [/(?<!\p{L})(?:три|трех|трёх)(?!\p{L})/giu, "3"],
  [/(?<!\p{L})(?:четыре|четырех|четырёх)(?!\p{L})/giu, "4"],
  [/(?<!\p{L})(?:пять|пяти|пят\p{L}*)(?!\p{L})/giu, "5"],
  [/(?<!\p{L})(?:шесть|шести|шест\p{L}*)(?!\p{L})/giu, "6"],
  [/(?<!\p{L})(?:семь|семи|седьм\p{L}*)(?!\p{L})/giu, "7"],
  [/(?<!\p{L})(?:восемь|восьми|восьм\p{L}*)(?!\p{L})/giu, "8"],
  [/(?<!\p{L})(?:девять|девяти|девят\p{L}*)(?!\p{L})/giu, "9"],
  [/(?<!\p{L})(?:десять|десяти|десят\p{L}*)(?!\p{L})/giu, "10"],
  [/(?<!\p{L})полгода(?!\p{L})/giu, "0.5-year"],
];

function clean(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[«»„“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizedMatch(text: string, phrase: string): boolean {
  const needle = clean(phrase);
  return Boolean(needle) && clean(text).includes(needle);
}

function extracted(pattern: RegExp, text: string): string[] {
  pattern.lastIndex = 0;
  return unique([...text.matchAll(pattern)].map((match) => clean(match[0]).replace(/[),.;:!?]+$/u, "")));
}

function withoutListMarkersAndUrls(text: string): string {
  return text
    .replace(URL, " ")
    .replace(/^\s*\d+[.)]\s+/gmu, " ");
}

function numberConcepts(text: string): string[] {
  const value = withoutListMarkersAndUrls(text);
  const result = [...value.matchAll(/(?<![\p{L}\p{N}])\d+(?:[ \u00a0]\d{3})*(?:[.,]\d+)?(?::\d{2})?(?![\p{L}\p{N}])/gu)]
    .map((match) => match[0].replace(/[ \u00a0]/g, "").replace(",", "."));
  for (const [pattern, concept] of NUMBER_WORDS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) result.push(concept);
  }
  return unique(result);
}

function dateConcepts(text: string): string[] {
  return unique([...extracted(TEXT_DATE, text), ...extracted(NUMERIC_DATE, text)]).map((date) =>
    date.replace(/\s+года?$/u, "").trim(),
  );
}

function legalConcepts(text: string): string[] {
  return extracted(LEGAL_REFERENCE, text).map((citation) =>
    citation
      .replace(/^(?:стать[ьяиюе]*|ст\.)\s*/u, "ст. ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function evidenceText(ledger: FactLedger): string {
  return ledger.evidence.map((item) => item.text).join("\n");
}

function contentTokens(text: string): string[] {
  return unique(clean(text).match(/[\p{L}]{4,}/gu) ?? []).filter(
    (word) => !["который", "которая", "которые", "этого", "также", "только", "может", "будет"].includes(word),
  );
}

function claimSupported(sentence: string, evidence: string): boolean {
  const normalizedSentence = clean(sentence).replace(/[.!?…]+$/u, "");
  const normalizedEvidence = clean(evidence);
  if (!normalizedSentence) return true;
  if (normalizedEvidence.includes(normalizedSentence)) return true;
  const tokens = contentTokens(normalizedSentence);
  if (tokens.length < 3) return false;
  const hits = tokens.filter((token) => normalizedEvidence.includes(token)).length;
  return hits / tokens.length >= 0.75;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function factLedgerHash(ledger: FactLedger): string {
  return `fl1-${fnv1a(JSON.stringify(ledger))}`;
}

function requestedLength(task: string, settings: PostSettings): [number | undefined, number | undefined] {
  const explicit = task.match(/\b(\d{2,5})\s*[–—-]\s*(\d{2,5})\s*(?:знак\p{L}*|символ\p{L}*)/iu);
  if (explicit) return [Number(explicit[1]), Number(explicit[2])];
  if (settings.length === "custom") return [settings.customMinChars ?? undefined, settings.customMaxChars ?? undefined];
  return [undefined, undefined];
}

function domainFor(text: string): FactDomain {
  if (/(?:банкрот|арбитраж|гпк|договор|юрист|правов|закон|стать[ья])/iu.test(text)) return "legal";
  if (/(?:анонс|регистрац|мероприят|встреч[аи]|вебинар|сентябр|октябр|ноябр|декабр)/iu.test(text)) return "event";
  if (/(?:искусственн\p{L}*\s+интеллект|\bии\b|систем\p{L}*\s+анализ)/iu.test(text)) return "technology";
  return "general";
}

function factFragments(task: string): string[] {
  return task
    .split(/\n+|(?<=[.!?;])\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 15)
    .filter((part) =>
      /(?:\d|https?:\/\/|стать[ья]|ст\.|составля\p{L}*|исключа\p{L}*|аудитори\p{L}*|цель\p{L}*|бесплатн\p{L}*|решени\p{L}*|источник\p{L}*|анализир\p{L}*)/iu.test(part),
    )
    .slice(0, 20)
    .map((part) => part.slice(0, 500));
}

/** Строит минимальный закрытый ledger из уже существующего контракта Studio. */
export function buildFactLedger(input: {
  task: string;
  postSettings?: unknown;
  knownFacts?: string[];
  profile?: string;
}): FactLedger {
  const settings = normalizePostSettings(input.postSettings);
  const strict = settings.factStrictness !== "general";
  const required: FactRequirement[] = settings.requiredFacts.map((fact, index) => ({
    id: `required-${index + 1}`,
    label: fact,
    variants: [fact],
  }));
  const requiredProofs = settings.proofs.filter((proof) => proof.required);
  required.push(...requiredProofs.map((proof, index) => ({
    id: proof.id || `proof-${index + 1}`,
    label: proof.text,
    variants: [proof.text],
  })));
  const fragments = factFragments(input.task);
  const evidence: FactEvidence[] = [
    { id: "brief", text: input.task, source: "brief" as const, countsForCapacity: false },
    ...fragments.map((text, index) => ({
      id: `brief-fact-${index + 1}`,
      text,
      source: "brief" as const,
      countsForCapacity: true,
    })),
    ...(input.knownFacts ?? []).map((text, index) => ({
      id: `knowledge-${index + 1}`,
      text,
      source: "knowledge" as const,
      countsForCapacity: true,
    })),
    ...settings.requiredFacts.map((text, index) => ({
      id: `required-${index + 1}`,
      text,
      source: "required_fact" as const,
      countsForCapacity: true,
    })),
    ...requiredProofs.map((proof, index) => ({
      id: proof.id || `proof-${index + 1}`,
      text: proof.text,
      source: "proof" as const,
      countsForCapacity: true,
    })),
    ...(input.profile?.trim()
      ? [{ id: "profile", text: input.profile, source: "profile" as const, countsForCapacity: false }]
      : []),
  ].filter((item) => item.text.trim());
  const [requestedMinChars, requestedMaxChars] = requestedLength(input.task, settings);
  const emojiMax = settings.emojiMode === "none"
    ? 0
    : settings.emojiMode === "custom"
      ? (settings.emojiMax ?? undefined)
      : undefined;
  return {
    version: 1,
    policy: strict ? "closed_world" : "allow_general",
    domain: domainFor(`${input.task}\n${settings.requiredFacts.join("\n")}`),
    evidence,
    required,
    requiredUrls: unique([...settings.links, /^https?:\/\//iu.test(settings.ctaDestination) ? settings.ctaDestination : ""]),
    forbiddenPhrases: unique([...settings.forbiddenWords, ...settings.bannedExpressions]),
    forbiddenClaims: [],
    constraints: {
      maxEmoji: emojiMax,
      maxHashtags: settings.hashtags === "none" ? 0 : settings.hashtagCount ?? undefined,
      cta: settings.cta === "none" ? "forbidden" : settings.cta === "auto" ? "any" : "required",
      ctaPhrases: unique([settings.ctaWording, settings.ctaDestination]),
      forbidArtificialContrast: settings.blockAiCliches,
    },
    requestedMinChars,
    requestedMaxChars,
  };
}

export function preflightFactLedger(ledger: FactLedger): FactPreflightResult {
  if (ledger.policy !== "closed_world" || ledger.domain !== "legal" || !ledger.requestedMinChars) {
    return { passed: true, issues: [] };
  }
  const capacityEvidence = unique(
    ledger.evidence
      .filter((item) => item.countsForCapacity !== false)
      .map((item) => clean(item.text)),
  );
  const evidenceChars = capacityEvidence.join(" ").length;
  // Это не обещание «идеальной длины», а fail-fast от очевидной инфляции: для строгого
  // юридического текста допускаем связки и пояснения, но не четырёхкратное раздувание.
  const estimatedGroundedChars = Math.max(500, Math.round(evidenceChars * 2.2 + capacityEvidence.length * 80));
  if (ledger.requestedMinChars <= estimatedGroundedChars) return { passed: true, issues: [] };
  return {
    passed: false,
    issues: [{
      code: "insufficient_grounded_material",
      message: "Для заданного объёма недостаточно подтверждённых юридических фактов. Сократи текст или добавь проверенные источники.",
      requestedMinChars: ledger.requestedMinChars,
      estimatedGroundedChars,
      evidenceCount: capacityEvidence.length,
    }],
  };
}

export function validateFactualOutput(
  text: string,
  ledger: FactLedger,
  options: { now?: () => Date } = {},
): FactualValidationResult {
  const value = String(text ?? "").trim();
  const evidence = evidenceText(ledger);
  const violations: FactualViolation[] = [];
  const rulesRun = new Set<string>();
  const seen = new Set<string>();
  const add = (violation: FactualViolation) => {
    const key = `${violation.code}:${violation.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      violations.push(violation);
    }
  };

  rulesRun.add("required_facts");
  for (const requirement of ledger.required) {
    if (!requirement.variants.some((variant) => normalizedMatch(value, variant))) {
      add({
        code: "missing_required_fact",
        message: `Не сохранён обязательный факт: ${requirement.label}`,
        blocker: true,
        evidenceId: requirement.id,
      });
    }
  }

  rulesRun.add("urls");
  const allowedUrls = new Set(extracted(URL, evidence));
  const outputUrls = extracted(URL, value);
  for (const requiredUrl of ledger.requiredUrls) {
    if (!value.includes(requiredUrl)) add({ code: "missing_required_url", message: `Нет точной ссылки: ${requiredUrl}`, blocker: true });
    allowedUrls.add(clean(requiredUrl));
  }
  for (const url of outputUrls) {
    if (!allowedUrls.has(url)) add({ code: "unsupported_url", message: `Ссылка не подтверждена брифом: ${url}`, blocker: true });
  }

  if (ledger.policy === "closed_world") {
    rulesRun.add("closed_world_numbers_dates_citations");
    const allowedNumbers = new Set(numberConcepts(evidence));
    for (const number of numberConcepts(value)) {
      if (!allowedNumbers.has(number)) add({ code: "unsupported_number", message: `Число не подтверждено источниками: ${number}`, blocker: true });
    }
    const allowedDates = new Set(dateConcepts(evidence));
    for (const date of dateConcepts(value)) {
      if (!allowedDates.has(date)) add({ code: "unsupported_date", message: `Дата не подтверждена источниками: ${date}`, blocker: true });
    }
    const allowedLegal = new Set(legalConcepts(evidence));
    for (const citation of legalConcepts(value)) {
      if (!allowedLegal.has(citation)) {
        add({ code: "unsupported_legal_reference", message: `Правовая ссылка не подтверждена: ${citation}`, blocker: true });
      }
    }

    rulesRun.add("high_risk_claim_markers");
    const sentences = value.split(/(?<=[.!?…])\s+|\n+/u).map((sentence) => sentence.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (CLAIM_MARKER.test(sentence) && !claimSupported(sentence, evidence)) {
        add({ code: "unsupported_claim", message: `Утверждение не подтверждено источниками: ${sentence.slice(0, 180)}`, blocker: true });
      }
    }
  }

  rulesRun.add("explicit_forbidden_claims");
  for (const phrase of ledger.forbiddenPhrases) {
    if (normalizedMatch(value, phrase)) add({ code: "forbidden_phrase", message: `Запрещённая формулировка: ${phrase}`, blocker: true });
  }
  for (const claim of ledger.forbiddenClaims) {
    if (claim.variants.some((variant) => normalizedMatch(value, variant))) {
      add({ code: "forbidden_claim", message: `Запрещённое утверждение: ${claim.label}`, blocker: true, evidenceId: claim.id });
    }
  }

  const constraints = ledger.constraints;
  rulesRun.add("format_and_style_constraints");
  if (constraints.forbidArtificialContrast && ARTIFICIAL_CONTRAST.test(value)) {
    add({ code: "artificial_contrast", message: "Использована искусственная конструкция противопоставления «не X — Y»", blocker: true });
  }
  if (constraints.forbidPromises && PROMISE.test(value)) {
    add({ code: "promise", message: "В тексте появилось неподтверждённое обещание результата", blocker: true });
  }
  if (constraints.forbidAdvice && ADVICE.test(value)) {
    add({ code: "advice", message: "В тексте появился совет, которого нет в закрытом брифе", blocker: true });
  }
  const emojiCount = (value.match(EMOJI) ?? []).length;
  if (constraints.maxEmoji !== undefined && emojiCount > constraints.maxEmoji) {
    add({ code: "emoji_limit", message: `Эмодзи ${emojiCount}, разрешено максимум ${constraints.maxEmoji}`, blocker: true });
  }
  const hashtagCount = (value.match(HASHTAG) ?? []).length;
  if (constraints.maxHashtags !== undefined && hashtagCount > constraints.maxHashtags) {
    add({ code: "hashtag_limit", message: `Хэштегов ${hashtagCount}, разрешено максимум ${constraints.maxHashtags}`, blocker: true });
  }
  const questionCount = (value.match(/\?/gu) ?? []).length;
  if (
    (constraints.minQuestions !== undefined && questionCount < constraints.minQuestions)
    || (constraints.maxQuestions !== undefined && questionCount > constraints.maxQuestions)
  ) {
    add({ code: "question_count", message: `Количество вопросов ${questionCount} не соответствует брифу`, blocker: true });
  }
  if (constraints.requireWhyQuestion && !/(?:почему|по какой причине|что именно.+почему)[^?]*\?/iu.test(value)) {
    add({ code: "question_reason", message: "Нужен один содержательный вопрос с просьбой объяснить причину", blocker: true });
  }
  const hasCta = CTA.test(value) || (constraints.ctaPhrases ?? []).some((phrase) => normalizedMatch(value, phrase));
  if (constraints.cta === "forbidden" && hasCta) add({ code: "unexpected_cta", message: "Призыв запрещён заданием", blocker: true });
  if (constraints.cta === "required" && !hasCta) add({ code: "missing_cta", message: "Не найден обязательный призыв", blocker: true });

  for (const group of constraints.choiceGroups ?? []) {
    const selected = group.choices.filter((choice) => choice.variants.some((variant) => normalizedMatch(value, variant)));
    if (selected.length < group.min || selected.length > group.max) {
      add({
        code: "choice_count",
        message: `${group.label}: выбрано ${selected.length}, требуется ${group.min === group.max ? group.min : `${group.min}–${group.max}`}`,
        blocker: true,
        evidenceId: group.id,
      });
    }
  }

  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const passed = violations.length === 0;
  return {
    status: passed ? "passed" : "blocked",
    passed,
    requiresReview: false,
    violations,
    provenance: {
      validatorVersion: "fact-ledger-v1",
      ledgerHash: factLedgerHash(ledger),
      checkedAt,
      coverage: "deterministic",
      semanticEntailment: "not_run",
      rulesRun: [...rulesRun],
      sourceIds: ledger.evidence.map((item) => item.id),
    },
  };
}

export function buildFactualRepairInstructions(result: FactualValidationResult): string[] {
  return result.violations.map((item) => item.message).slice(0, 12);
}
