import { createHash } from "node:crypto";

export const LEGAL_VIDEO_DURATIONS = [30, 45, 60] as const;

export type LegalVideoDuration = (typeof LEGAL_VIDEO_DURATIONS)[number];
export type LegalVideoSceneRole = "hook" | "body" | "cta";

export type LegalVideoSourceDraft = {
  id: number;
  revision: number;
  contentHash: string;
  title: string;
  body: string;
};

export type LegalVideoEvidenceSource =
  | {
      kind: "draft";
      draftId: number;
      draftRevision: number;
      draftContentHash: string;
    }
  | {
      kind: "verified_source";
      sourceId: string;
      title: string;
      url: string;
      checkedAt: string;
      sourceContentHash: string;
    };

export type LegalVideoEvidenceInput = {
  id: string;
  label: string;
  claim: string;
  excerpt: string;
  source: LegalVideoEvidenceSource;
};

export type LegalVideoEvidence = LegalVideoEvidenceInput & {
  evidenceHash: string;
};

export type LegalVideoSceneInput = {
  id: string;
  order: number;
  role: LegalVideoSceneRole;
  durationSeconds: number;
  voiceOver: string;
  onScreenText: string;
  visualDirection: string;
  sourceClaimIds: readonly string[];
};

export type LegalVideoScene = LegalVideoSceneInput & {
  /** Explicit production metadata. Values here are not treated as factual claims. */
  productionTiming: {
    startSecond: number;
    endSecond: number;
  };
};

export type LegalVideoScriptInput = {
  id: string;
  projectId: number;
  revision: number;
  title: string;
  durationSeconds: LegalVideoDuration;
  sourceDraft: LegalVideoSourceDraft;
  sourceEvidence: readonly LegalVideoEvidenceInput[];
  scenes: readonly LegalVideoSceneInput[];
};

export type LegalVideoScript = {
  schemaVersion: 1;
  id: string;
  projectId: number;
  revision: number;
  revisionHash: string;
  title: string;
  durationSeconds: LegalVideoDuration;
  sourceDraft: LegalVideoSourceDraft;
  sourceEvidence: readonly LegalVideoEvidence[];
  scenes: readonly LegalVideoScene[];
};

export type LegalVideoValidationIssue = {
  path: string;
  code:
    | "invalid_type"
    | "invalid_value"
    | "out_of_bounds"
    | "hostile_text"
    | "hash_mismatch"
    | "source_mismatch"
    | "unknown_source_claim"
    | "unsupported_factual_marker";
  message: string;
  marker?: string;
};

export class LegalVideoValidationError extends Error {
  readonly issues: readonly LegalVideoValidationIssue[];

  constructor(issues: readonly LegalVideoValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "LegalVideoValidationError";
    this.issues = issues;
  }
}

export type LegalVideoFactualMarker = {
  kind: "number" | "date" | "amount" | "percentage" | "article" | "case";
  value: string;
  display: string;
};

type AnyRecord = Record<string, unknown>;

const IDENTIFIER_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const FORBIDDEN_TEXT_PATTERN = /(?:<\s*\/?\s*(?:script|iframe|object|embed|style|meta|link)\b|javascript\s*:|data\s*:\s*text\/html|[\u202a-\u202e\u2066-\u2069\ufeff])/iu;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/giu;
const LEGAL_CODE_PATTERN = "(?:ГК|ГПК|АПК|УК|УПК|НК|ТК|ЖК|СК|КоАП)\\s+РФ|(?:44|127|223)-ФЗ";

const MONTHS: Readonly<Record<string, string>> = {
  января: "01",
  февраля: "02",
  марта: "03",
  апреля: "04",
  мая: "05",
  июня: "06",
  июля: "07",
  августа: "08",
  сентября: "09",
  октября: "10",
  ноября: "11",
  декабря: "12",
};

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  ноль: 0,
  один: 1,
  одна: 1,
  одно: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
  тринадцать: 13,
  четырнадцать: 14,
  пятнадцать: 15,
  шестнадцать: 16,
  семнадцать: 17,
  восемнадцать: 18,
  девятнадцать: 19,
  двадцать: 20,
  тридцать: 30,
  сорок: 40,
  пятьдесят: 50,
  шестьдесят: 60,
  семьдесят: 70,
  восемьдесят: 80,
  девяносто: 90,
  сто: 100,
};

const QUANTITY_UNIT_CANONICAL: Readonly<Record<string, string>> = {
  секунда: "секунда",
  секунды: "секунда",
  секунд: "секунда",
  минута: "минута",
  минуты: "минута",
  минут: "минута",
  час: "час",
  часа: "час",
  часов: "час",
  день: "день",
  дня: "день",
  дней: "день",
  неделя: "неделя",
  недели: "неделя",
  недель: "неделя",
  месяц: "месяц",
  месяца: "месяц",
  месяцев: "месяц",
  год: "год",
  года: "год",
  лет: "год",
  процент: "процент",
  процента: "процент",
  процентов: "процент",
  рубль: "рубль",
  рубля: "рубль",
  рублей: "рубль",
};

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  issues: LegalVideoValidationIssue[],
  path: string,
  code: LegalVideoValidationIssue["code"],
  message: string,
  marker?: string,
) {
  issues.push({ path, code, message, ...(marker ? { marker } : {}) });
}

function recordAt(value: unknown, path: string, issues: LegalVideoValidationIssue[]): AnyRecord {
  if (isRecord(value)) return value;
  issue(issues, path, "invalid_type", "Ожидался объект");
  return {};
}

function boundedText(
  value: unknown,
  path: string,
  issues: LegalVideoValidationIssue[],
  options: { min: number; max: number; multiline?: boolean; preserve?: boolean },
) {
  if (typeof value !== "string") {
    issue(issues, path, "invalid_type", "Ожидалась строка");
    return "";
  }
  const result = options.preserve ? value : value.normalize("NFC").trim();
  if (result.length < options.min || result.length > options.max) {
    issue(issues, path, "out_of_bounds", `Допустимо от ${options.min} до ${options.max} знаков`);
  }
  if (!options.multiline && /[\r\n]/u.test(result)) {
    issue(issues, path, "invalid_value", "Переносы строк здесь недопустимы");
  }
  if (CONTROL_PATTERN.test(result) || FORBIDDEN_TEXT_PATTERN.test(result)) {
    issue(issues, path, "hostile_text", "Обнаружена небезопасная управляющая или исполняемая конструкция");
  }
  return result;
}

function positiveInteger(
  value: unknown,
  path: string,
  issues: LegalVideoValidationIssue[],
  max = Number.MAX_SAFE_INTEGER,
) {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    issue(issues, path, "invalid_value", `Ожидалось целое число от 1 до ${max}`);
    return 1;
  }
  return value as number;
}

function identifier(value: unknown, path: string, issues: LegalVideoValidationIssue[]) {
  const result = boundedText(value, path, issues, { min: 1, max: 128 });
  if (result && !IDENTIFIER_PATTERN.test(result)) {
    issue(issues, path, "invalid_value", "Недопустимый идентификатор");
  }
  return result;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function legalVideoDraftContentHash(body: string) {
  return sha256(body);
}

function hashAt(value: unknown, path: string, issues: LegalVideoValidationIssue[]) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    issue(issues, path, "invalid_value", "Ожидался SHA-256 в нижнем регистре");
    return "";
  }
  return value;
}

function normalizeNumericToken(value: string) {
  const compact = value.replace(/[\s\u00a0]/gu, "").replace(",", ".");
  if (/^\d+$/u.test(compact)) return compact.replace(/^0+(?=\d)/u, "");
  const [whole = "0", fraction = ""] = compact.split(".");
  return `${whole.replace(/^0+(?=\d)/u, "")}.${fraction.replace(/0+$/u, "") || "0"}`;
}

function addMarker(
  target: Map<string, LegalVideoFactualMarker>,
  kind: LegalVideoFactualMarker["kind"],
  value: string,
  display: string,
) {
  const key = `${kind}:${value}`;
  if (!target.has(key)) target.set(key, { kind, value, display });
}

function canonicalQuantityUnit(value: string) {
  const normalized = value.toLocaleLowerCase("ru-RU");
  return QUANTITY_UNIT_CANONICAL[normalized] ?? normalized;
}

/**
 * Extracts only deterministic factual markers. It deliberately does not try to
 * decide whether prose is legally true; semantic review remains a separate gate.
 */
export function extractLegalVideoFactualMarkers(text: string): LegalVideoFactualMarker[] {
  const markers = new Map<string, LegalVideoFactualMarker>();
  const normalized = text.normalize("NFC");
  const withoutUrls = normalized.replace(URL_PATTERN, " ");

  for (const match of withoutUrls.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/gu)) {
    addMarker(markers, "date", `${match[1]}-${match[2]}-${match[3]}`, match[0]);
  }
  for (const match of withoutUrls.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](\d{2,4})\b/gu)) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    addMarker(markers, "date", `${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`, match[0]);
  }
  for (const match of withoutUrls.matchAll(/(?<![\p{L}\d])(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4})(?:\s+года?)?)?(?![\p{L}\d])/giu)) {
    const month = MONTHS[match[2].toLowerCase()];
    addMarker(markers, "date", `${match[3] ?? "----"}-${month}-${match[1].padStart(2, "0")}`, match[0]);
  }

  const articlePattern = new RegExp(
    `(?<![\\p{L}\\d])(?:ч(?:асть)?\\.?\\s*(\\d+(?:\\.\\d+)*)\\s+)?ст(?:атья)?\\.?\\s*(\\d+(?:\\.\\d+)*)(?:\\s+(${LEGAL_CODE_PATTERN}))?(?![\\p{L}\\d])`,
    "giu",
  );
  for (const match of withoutUrls.matchAll(articlePattern)) {
    const part = match[1] ? normalizeNumericToken(match[1]) : "";
    const article = normalizeNumericToken(match[2]);
    const code = (match[3] ?? "").toLocaleUpperCase("ru-RU").replace(/[^\p{L}\d-]+/gu, "");
    addMarker(markers, "article", `${part}:${article}`, match[0]);
    if (code) addMarker(markers, "article", `${part}:${article}:${code}`, match[0]);
  }

  for (const match of withoutUrls.matchAll(/(?<![\p{L}\d])(?:дел[оа]\s+№?\s*|№\s*)([А-ЯA-Z]?\d{1,4}-\d{2,12}\/\d{2,4}(?:-\d+)*)(?![\p{L}\d])/giu)) {
    addMarker(markers, "case", match[1].toLocaleUpperCase("ru-RU").replace(/\s+/gu, ""), match[0]);
  }
  for (const match of withoutUrls.matchAll(/\b([А-ЯA-Z]\d{1,4}-\d{2,12}\/\d{2,4}(?:-\d+)*)\b/gu)) {
    addMarker(markers, "case", match[1].toLocaleUpperCase("ru-RU"), match[0]);
  }

  for (const match of withoutUrls.matchAll(/(?<![\p{L}\d])(\d+(?:[.,]\d+)?)\s*(%|процент(?:а|ов)?)(?![\p{L}\d])/giu)) {
    addMarker(markers, "percentage", normalizeNumericToken(match[1]), match[0]);
  }
  for (const match of withoutUrls.matchAll(/(?<![\p{L}\d])(\d{1,3}(?:[ \u00a0]\d{3})+|\d+(?:[.,]\d+)?)\s*(₽|руб(?:ль|ля|лей|\.)?|р\.|\$|доллар(?:а|ов)?|€|евро)(?![\p{L}\d])/giu)) {
    const currency = match[2].toLowerCase().replace(/\./gu, "");
    const normalizedCurrency = /^(?:₽|р|руб)/u.test(currency)
      ? "RUB"
      : /^(?:\$|доллар)/u.test(currency) ? "USD" : "EUR";
    addMarker(markers, "amount", `${normalizeNumericToken(match[1])}:${normalizedCurrency}`, match[0]);
  }

  for (const match of withoutUrls.matchAll(/(?<![\p{L}\d])(\d{1,3}(?:[ \u00a0]\d{3})+|\d+(?:[.,]\d+)?)\s+([\p{L}]{2,32})(?![\p{L}\d])/giu)) {
    addMarker(
      markers,
      "number",
      `${normalizeNumericToken(match[1])}@${canonicalQuantityUnit(match[2])}`,
      match[0],
    );
  }

  for (const match of withoutUrls.matchAll(/\b(?:\d{1,3}(?:[ \u00a0]\d{3})+|\d+(?:[.,]\d+)?)\b/gu)) {
    addMarker(markers, "number", normalizeNumericToken(match[0]), match[0]);
  }
  for (const match of withoutUrls.toLowerCase().matchAll(/[а-яё]+/gu)) {
    const numeric = NUMBER_WORDS[match[0]];
    if (numeric != null) addMarker(markers, "number", String(numeric), match[0]);
  }
  const numberWordPattern = new RegExp(
    `(?<![\\p{L}\\d])(${Object.keys(NUMBER_WORDS).join("|")})\\s+(процент(?:а|ов)?)(?![\\p{L}\\d])`,
    "giu",
  );
  for (const match of withoutUrls.matchAll(numberWordPattern)) {
    addMarker(markers, "percentage", String(NUMBER_WORDS[match[1].toLowerCase()]), match[0]);
  }
  const wordQuantityPattern = new RegExp(
    `(?<![\\p{L}\\d])(${Object.keys(NUMBER_WORDS).join("|")})\\s+([\\p{L}]{2,32})(?![\\p{L}\\d])`,
    "giu",
  );
  for (const match of withoutUrls.matchAll(wordQuantityPattern)) {
    addMarker(
      markers,
      "number",
      `${NUMBER_WORDS[match[1].toLowerCase()]}@${canonicalQuantityUnit(match[2])}`,
      match[0],
    );
  }

  return [...markers.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value)
  );
}

function markerKeys(text: string) {
  return new Set(extractLegalVideoFactualMarkers(text).map((marker) => `${marker.kind}:${marker.value}`));
}

function unsupportedMarkers(text: string, sourceMaterial: string) {
  const allowed = markerKeys(sourceMaterial);
  return extractLegalVideoFactualMarkers(text).filter((marker) => !allowed.has(`${marker.kind}:${marker.value}`));
}

function sourceDraftAt(value: unknown, issues: LegalVideoValidationIssue[]): LegalVideoSourceDraft {
  const source = recordAt(value, "sourceDraft", issues);
  const body = boundedText(source.body, "sourceDraft.body", issues, {
    min: 1,
    max: 100_000,
    multiline: true,
    preserve: true,
  });
  const contentHash = hashAt(source.contentHash, "sourceDraft.contentHash", issues);
  if (contentHash && contentHash !== legalVideoDraftContentHash(body)) {
    issue(issues, "sourceDraft.contentHash", "hash_mismatch", "Хэш не соответствует точному тексту черновика");
  }
  return {
    id: positiveInteger(source.id, "sourceDraft.id", issues),
    revision: positiveInteger(source.revision, "sourceDraft.revision", issues),
    contentHash,
    title: boundedText(source.title, "sourceDraft.title", issues, { min: 1, max: 240 }),
    body,
  };
}

function verifiedSourceAt(
  value: AnyRecord,
  path: string,
  issues: LegalVideoValidationIssue[],
): LegalVideoEvidenceSource {
  const urlValue = boundedText(value.url, `${path}.url`, issues, { min: 1, max: 2_048 });
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("unsafe_url");
  } catch {
    issue(issues, `${path}.url`, "invalid_value", "Нужна публичная HTTPS-ссылка без учётных данных");
  }
  const checkedAt = boundedText(value.checkedAt, `${path}.checkedAt`, issues, { min: 20, max: 32 });
  const checkedDate = new Date(checkedAt);
  if (Number.isNaN(checkedDate.getTime()) || checkedDate.toISOString() !== checkedAt) {
    issue(issues, `${path}.checkedAt`, "invalid_value", "Нужна точная дата проверки в ISO UTC");
  }
  return {
    kind: "verified_source",
    sourceId: identifier(value.sourceId, `${path}.sourceId`, issues),
    title: boundedText(value.title, `${path}.title`, issues, { min: 1, max: 240 }),
    url: urlValue,
    checkedAt,
    sourceContentHash: hashAt(value.sourceContentHash, `${path}.sourceContentHash`, issues),
  };
}

function evidenceHash(value: LegalVideoEvidenceInput) {
  return sha256(JSON.stringify({
    id: value.id,
    label: value.label,
    claim: value.claim,
    excerpt: value.excerpt,
    source: value.source,
  }));
}

function evidenceAt(
  value: unknown,
  index: number,
  sourceDraft: LegalVideoSourceDraft,
  issues: LegalVideoValidationIssue[],
  requireHash: boolean,
): LegalVideoEvidence {
  const path = `sourceEvidence.${index}`;
  const evidence = recordAt(value, path, issues);
  const rawSource = recordAt(evidence.source, `${path}.source`, issues);
  let source: LegalVideoEvidenceSource;
  if (rawSource.kind === "draft") {
    source = {
      kind: "draft",
      draftId: positiveInteger(rawSource.draftId, `${path}.source.draftId`, issues),
      draftRevision: positiveInteger(rawSource.draftRevision, `${path}.source.draftRevision`, issues),
      draftContentHash: hashAt(rawSource.draftContentHash, `${path}.source.draftContentHash`, issues),
    };
    if (
      source.draftId !== sourceDraft.id
      || source.draftRevision !== sourceDraft.revision
      || source.draftContentHash !== sourceDraft.contentHash
    ) {
      issue(issues, `${path}.source`, "source_mismatch", "Основание привязано не к этой ревизии черновика");
    }
  } else if (rawSource.kind === "verified_source") {
    source = verifiedSourceAt(rawSource, `${path}.source`, issues);
  } else {
    issue(issues, `${path}.source.kind`, "invalid_value", "Допустим источник draft или verified_source");
    source = {
      kind: "draft",
      draftId: sourceDraft.id,
      draftRevision: sourceDraft.revision,
      draftContentHash: sourceDraft.contentHash,
    };
  }
  const normalized: LegalVideoEvidenceInput = {
    id: identifier(evidence.id, `${path}.id`, issues),
    label: boundedText(evidence.label, `${path}.label`, issues, { min: 1, max: 160 }),
    claim: boundedText(evidence.claim, `${path}.claim`, issues, { min: 1, max: 600, multiline: true }),
    excerpt: boundedText(evidence.excerpt, `${path}.excerpt`, issues, { min: 1, max: 4_000, multiline: true }),
    source,
  };
  if (source.kind === "draft" && !sourceDraft.body.includes(normalized.excerpt)) {
    issue(issues, `${path}.excerpt`, "source_mismatch", "Цитируемый фрагмент отсутствует в точной ревизии черновика");
  }
  for (const marker of unsupportedMarkers(normalized.claim, normalized.excerpt)) {
    issue(
      issues,
      `${path}.claim`,
      "unsupported_factual_marker",
      `Маркер «${marker.display}» отсутствует в цитируемом фрагменте`,
      `${marker.kind}:${marker.value}`,
    );
  }
  const calculatedHash = evidenceHash(normalized);
  if (requireHash) {
    const suppliedHash = hashAt(evidence.evidenceHash, `${path}.evidenceHash`, issues);
    if (suppliedHash && suppliedHash !== calculatedHash) {
      issue(issues, `${path}.evidenceHash`, "hash_mismatch", "Основание было изменено после фиксации");
    }
  }
  return { ...normalized, evidenceHash: calculatedHash };
}

function sceneInputFrom(value: unknown, index: number, issues: LegalVideoValidationIssue[]) {
  const path = `scenes.${index}`;
  const scene = recordAt(value, path, issues);
  const rawRole = scene.role;
  const role: LegalVideoSceneRole = rawRole === "hook" || rawRole === "body" || rawRole === "cta"
    ? rawRole
    : "body";
  if (role !== rawRole) issue(issues, `${path}.role`, "invalid_value", "Допустимы hook, body или cta");
  const rawClaimIds = Array.isArray(scene.sourceClaimIds) ? scene.sourceClaimIds : [];
  if (!Array.isArray(scene.sourceClaimIds)) {
    issue(issues, `${path}.sourceClaimIds`, "invalid_type", "Ожидался массив идентификаторов оснований");
  }
  if (rawClaimIds.length > 20) {
    issue(issues, `${path}.sourceClaimIds`, "out_of_bounds", "Допустимо не более 20 оснований на сцену");
  }
  return {
    input: {
      id: identifier(scene.id, `${path}.id`, issues),
      order: positiveInteger(scene.order, `${path}.order`, issues, 12),
      role,
      durationSeconds: positiveInteger(scene.durationSeconds, `${path}.durationSeconds`, issues, 60),
      voiceOver: boundedText(scene.voiceOver, `${path}.voiceOver`, issues, { min: 1, max: 1_500, multiline: true }),
      onScreenText: boundedText(scene.onScreenText, `${path}.onScreenText`, issues, { min: 1, max: 280, multiline: true }),
      visualDirection: boundedText(scene.visualDirection, `${path}.visualDirection`, issues, { min: 1, max: 800, multiline: true }),
      sourceClaimIds: rawClaimIds.map((claimId, claimIndex) =>
        identifier(claimId, `${path}.sourceClaimIds.${claimIndex}`, issues)
      ),
    } satisfies LegalVideoSceneInput,
    suppliedTiming: isRecord(scene.productionTiming) ? scene.productionTiming : null,
  };
}

function revisionHash(script: Omit<LegalVideoScript, "revisionHash">) {
  return sha256(JSON.stringify({
    schemaVersion: script.schemaVersion,
    id: script.id,
    projectId: script.projectId,
    revision: script.revision,
    title: script.title,
    durationSeconds: script.durationSeconds,
    sourceDraft: script.sourceDraft,
    sourceEvidence: script.sourceEvidence,
    scenes: script.scenes,
  }));
}

export function legalVideoRevisionHash(script: Omit<LegalVideoScript, "revisionHash">) {
  return revisionHash(script);
}

function buildScript(value: unknown, requireComputedHashes: boolean): LegalVideoScript {
  const issues: LegalVideoValidationIssue[] = [];
  const input = recordAt(value, "script", issues);
  if ((requireComputedHashes || "schemaVersion" in input) && input.schemaVersion !== 1) {
    issue(issues, "schemaVersion", "invalid_value", "Поддерживается только версия схемы 1");
  }
  const duration = input.durationSeconds;
  const durationSeconds: LegalVideoDuration = LEGAL_VIDEO_DURATIONS.includes(duration as LegalVideoDuration)
    ? duration as LegalVideoDuration
    : 30;
  if (durationSeconds !== duration) {
    issue(issues, "durationSeconds", "invalid_value", "Допустим хронометраж 30, 45 или 60 секунд");
  }
  const sourceDraft = sourceDraftAt(input.sourceDraft, issues);
  const rawEvidence = Array.isArray(input.sourceEvidence) ? input.sourceEvidence : [];
  if (!Array.isArray(input.sourceEvidence)) {
    issue(issues, "sourceEvidence", "invalid_type", "Ожидался массив оснований");
  }
  if (rawEvidence.length < 1 || rawEvidence.length > 100) {
    issue(issues, "sourceEvidence", "out_of_bounds", "Нужно от 1 до 100 оснований");
  }
  const sourceEvidence = rawEvidence
    .map((item, index) => evidenceAt(item, index, sourceDraft, issues, requireComputedHashes))
    .sort((left, right) => left.id.localeCompare(right.id));
  const evidenceIds = new Set<string>();
  for (let index = 0; index < sourceEvidence.length; index += 1) {
    const evidence = sourceEvidence[index];
    if (evidenceIds.has(evidence.id)) {
      issue(issues, `sourceEvidence.${index}.id`, "invalid_value", "Идентификатор основания должен быть уникальным");
    }
    evidenceIds.add(evidence.id);
  }

  const rawScenes = Array.isArray(input.scenes) ? input.scenes : [];
  if (!Array.isArray(input.scenes)) issue(issues, "scenes", "invalid_type", "Ожидался массив сцен");
  if (rawScenes.length < 3 || rawScenes.length > 12) {
    issue(issues, "scenes", "out_of_bounds", "Сценарий должен содержать от 3 до 12 сцен");
  }
  const parsedScenes = rawScenes.map((scene, index) => sceneInputFrom(scene, index, issues));
  const sceneIds = new Set<string>();
  let elapsed = 0;
  const evidenceById = new Map(sourceEvidence.map((evidence) => [evidence.id, evidence]));
  const scenes: LegalVideoScene[] = parsedScenes.map(({ input: scene, suppliedTiming }, index) => {
    const path = `scenes.${index}`;
    if (sceneIds.has(scene.id)) issue(issues, `${path}.id`, "invalid_value", "Идентификатор сцены должен быть уникальным");
    sceneIds.add(scene.id);
    if (scene.order !== index + 1) {
      issue(issues, `${path}.order`, "invalid_value", "Порядок сцен должен быть непрерывным и начинаться с 1");
    }
    const expectedRole: LegalVideoSceneRole = index === 0
      ? "hook"
      : index === parsedScenes.length - 1 ? "cta" : "body";
    if (scene.role !== expectedRole) {
      issue(issues, `${path}.role`, "invalid_value", `Для этой позиции требуется роль ${expectedRole}`);
    }
    const uniqueClaimIds = new Set(scene.sourceClaimIds);
    if (uniqueClaimIds.size !== scene.sourceClaimIds.length) {
      issue(issues, `${path}.sourceClaimIds`, "invalid_value", "Основание нельзя указывать дважды");
    }
    for (const claimId of scene.sourceClaimIds) {
      if (!evidenceById.has(claimId)) {
        issue(issues, `${path}.sourceClaimIds`, "unknown_source_claim", `Основание «${claimId}» не существует`);
      }
    }
    if (scene.role !== "cta" && scene.sourceClaimIds.length === 0) {
      issue(issues, `${path}.sourceClaimIds`, "out_of_bounds", "Хук и содержательные сцены требуют хотя бы одно основание");
    }
    const citedMaterial = scene.sourceClaimIds
      .map((claimId) => evidenceById.get(claimId))
      .filter((evidence): evidence is LegalVideoEvidence => evidence != null)
      .map((evidence) => `${evidence.claim}\n${evidence.excerpt}`)
      .join("\n");
    const narrative = `${scene.voiceOver}\n${scene.onScreenText}\n${scene.visualDirection}`;
    for (const marker of unsupportedMarkers(narrative, citedMaterial)) {
      issue(
        issues,
        path,
        "unsupported_factual_marker",
        `Маркер «${marker.display}» отсутствует в указанных основаниях`,
        `${marker.kind}:${marker.value}`,
      );
    }
    const productionTiming = { startSecond: elapsed, endSecond: elapsed + scene.durationSeconds };
    if (requireComputedHashes && !suppliedTiming) {
      issue(issues, `${path}.productionTiming`, "invalid_type", "В сохранённой ревизии требуется точный производственный тайминг");
    }
    if (suppliedTiming) {
      if (
        suppliedTiming.startSecond !== productionTiming.startSecond
        || suppliedTiming.endSecond !== productionTiming.endSecond
      ) {
        issue(issues, `${path}.productionTiming`, "invalid_value", "Производственный тайминг не соответствует длительности и порядку сцен");
      }
    }
    elapsed = productionTiming.endSecond;
    return { ...scene, sourceClaimIds: [...scene.sourceClaimIds], productionTiming };
  });
  if (elapsed !== durationSeconds) {
    issue(issues, "scenes", "invalid_value", `Сумма сцен должна быть ровно ${durationSeconds} секунд, сейчас ${elapsed}`);
  }

  const withoutHash: Omit<LegalVideoScript, "revisionHash"> = {
    schemaVersion: 1,
    id: identifier(input.id, "id", issues),
    projectId: positiveInteger(input.projectId, "projectId", issues),
    revision: positiveInteger(input.revision, "revision", issues),
    title: boundedText(input.title, "title", issues, { min: 1, max: 180 }),
    durationSeconds,
    sourceDraft,
    sourceEvidence,
    scenes,
  };
  const calculatedRevisionHash = revisionHash(withoutHash);
  if (requireComputedHashes) {
    const suppliedHash = hashAt(input.revisionHash, "revisionHash", issues);
    if (suppliedHash && suppliedHash !== calculatedRevisionHash) {
      issue(issues, "revisionHash", "hash_mismatch", "Сценарий был изменён без создания новой ревизии");
    }
  }
  if (issues.length) throw new LegalVideoValidationError(issues);
  return { ...withoutHash, revisionHash: calculatedRevisionHash };
}

export function createLegalVideoScript(input: LegalVideoScriptInput): LegalVideoScript {
  return buildScript(input, false);
}

export function validateLegalVideoScript(input: unknown): LegalVideoScript {
  return buildScript(input, true);
}

export function reviseLegalVideoScript(
  current: LegalVideoScript,
  patch: {
    title?: string;
    durationSeconds?: LegalVideoDuration;
    scenes?: readonly LegalVideoSceneInput[];
  },
) {
  const validated = validateLegalVideoScript(current);
  const scenes = patch.scenes ?? validated.scenes.map((scene) => ({
    id: scene.id,
    order: scene.order,
    role: scene.role,
    durationSeconds: scene.durationSeconds,
    voiceOver: scene.voiceOver,
    onScreenText: scene.onScreenText,
    visualDirection: scene.visualDirection,
    sourceClaimIds: [...scene.sourceClaimIds],
  }));
  return createLegalVideoScript({
    id: validated.id,
    projectId: validated.projectId,
    revision: validated.revision + 1,
    title: patch.title ?? validated.title,
    durationSeconds: patch.durationSeconds ?? validated.durationSeconds,
    sourceDraft: validated.sourceDraft,
    sourceEvidence: validated.sourceEvidence.map((evidence) => ({
      id: evidence.id,
      label: evidence.label,
      claim: evidence.claim,
      excerpt: evidence.excerpt,
      source: evidence.source,
    })),
    scenes,
  });
}

function timecode(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Deterministic plain-text hand-off for an editor or production team. */
export function exportLegalVideoProductionBrief(value: LegalVideoScript) {
  const script = validateLegalVideoScript(value);
  const lines = [
    `СЦЕНАРИЙ КОРОТКОГО ВИДЕО — ${script.title}`,
    "",
    `Хронометраж: ${script.durationSeconds} сек.`,
    `Ревизия сценария: ${script.revision}`,
    `Хэш ревизии: ${script.revisionHash}`,
    `Исходный черновик: #${script.sourceDraft.id}, ревизия ${script.sourceDraft.revision}`,
    `Хэш исходного черновика: ${script.sourceDraft.contentHash}`,
    "",
    "ВАЖНО: материал носит информационный характер, не является юридической консультацией и требует проверки юристом перед публикацией.",
    "",
    "СЦЕНЫ",
  ];
  for (const scene of script.scenes) {
    const role = scene.role === "hook" ? "ХУК" : scene.role === "cta" ? "ПРИЗЫВ К ДЕЙСТВИЮ" : "ОСНОВНАЯ СЦЕНА";
    lines.push(
      "",
      `${scene.order}. ${timecode(scene.productionTiming.startSecond)}–${timecode(scene.productionTiming.endSecond)} · ${role}`,
      `Озвучка: ${scene.voiceOver}`,
      `Текст на экране: ${scene.onScreenText}`,
      `Визуал / B-roll: ${scene.visualDirection}`,
      `Основания: ${scene.sourceClaimIds.length ? scene.sourceClaimIds.join(", ") : "фактических утверждений нет"}`,
    );
  }
  lines.push("", "ИСТОЧНИКИ И ОСНОВАНИЯ");
  for (const evidence of script.sourceEvidence) {
    lines.push(
      "",
      `[${evidence.id}] ${evidence.label}`,
      `Тезис: ${evidence.claim}`,
      `Фрагмент: ${evidence.excerpt}`,
      evidence.source.kind === "draft"
        ? `Источник: черновик #${evidence.source.draftId}, ревизия ${evidence.source.draftRevision}, SHA-256 ${evidence.source.draftContentHash}`
        : `Источник: ${evidence.source.title} — ${evidence.source.url} (проверен ${evidence.source.checkedAt}, SHA-256 ${evidence.source.sourceContentHash})`,
      `Хэш основания: ${evidence.evidenceHash}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
