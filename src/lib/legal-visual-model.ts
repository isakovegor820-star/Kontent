export const LEGAL_VISUAL_FORMATS = ["1:1", "4:5", "9:16"] as const;

export type LegalVisualFormat = (typeof LEGAL_VISUAL_FORMATS)[number];

export const LEGAL_VISUAL_FONT_KEYS = [
  "aurora-sans",
  "legal-serif",
  "technical-mono",
] as const;

export type LegalVisualFontKey = (typeof LEGAL_VISUAL_FONT_KEYS)[number];

export const LEGAL_VISUAL_TEMPLATE_KEYS = [
  "what_changed",
  "three_actions",
  "deadlines",
  "business_mistake",
  "court_holding",
  "myth_fact",
  "checklist",
  "question_answer",
  "key_number",
  "announcement",
  "case_study",
] as const;

export type LegalVisualTemplateKey = (typeof LEGAL_VISUAL_TEMPLATE_KEYS)[number];

export const LEGAL_VISUAL_CARD_ROLES = [
  "hook",
  "context",
  "audience",
  "actions",
  "deadline",
  "caveat",
  "cta",
] as const;

export type LegalVisualCardRole = (typeof LEGAL_VISUAL_CARD_ROLES)[number];

export type LegalVisualTemplateDefinition = {
  key: LegalVisualTemplateKey;
  name: string;
  description: string;
  layout:
    | "change_split"
    | "numbered_steps"
    | "timeline"
    | "risk_notice"
    | "judicial_quote"
    | "binary_compare"
    | "check_rows"
    | "qa_stack"
    | "number_focus"
    | "event_ticket"
    | "case_flow";
  recommendedTheses: { min: number; max: number };
};

/**
 * The registry is product data rather than decorative aliases: every entry is
 * backed by a separate renderer layout in `legal-visual-render.ts`.
 */
export const LEGAL_VISUAL_TEMPLATES: readonly LegalVisualTemplateDefinition[] = [
  {
    key: "what_changed",
    name: "Что изменилось",
    description: "Сопоставление прежнего и нового правила",
    layout: "change_split",
    recommendedTheses: { min: 2, max: 4 },
  },
  {
    key: "three_actions",
    name: "3 действия",
    description: "Последовательность практических шагов",
    layout: "numbered_steps",
    recommendedTheses: { min: 3, max: 3 },
  },
  {
    key: "deadlines",
    name: "Сроки",
    description: "Лента дат и контрольных точек",
    layout: "timeline",
    recommendedTheses: { min: 2, max: 4 },
  },
  {
    key: "business_mistake",
    name: "Ошибка бизнеса",
    description: "Риск, последствие и безопасное действие",
    layout: "risk_notice",
    recommendedTheses: { min: 2, max: 4 },
  },
  {
    key: "court_holding",
    name: "Вывод суда",
    description: "Главный вывод судебного акта и оговорки",
    layout: "judicial_quote",
    recommendedTheses: { min: 1, max: 3 },
  },
  {
    key: "myth_fact",
    name: "Миф / факт",
    description: "Контраст заблуждения и проверенного факта",
    layout: "binary_compare",
    recommendedTheses: { min: 2, max: 2 },
  },
  {
    key: "checklist",
    name: "Чек-лист",
    description: "Короткий список для самопроверки",
    layout: "check_rows",
    recommendedTheses: { min: 3, max: 6 },
  },
  {
    key: "question_answer",
    name: "Вопрос / ответ",
    description: "Один практический вопрос и ясный ответ",
    layout: "qa_stack",
    recommendedTheses: { min: 1, max: 3 },
  },
  {
    key: "key_number",
    name: "Цифра",
    description: "Одна ключевая цифра с пояснением",
    layout: "number_focus",
    recommendedTheses: { min: 1, max: 2 },
  },
  {
    key: "announcement",
    name: "Анонс",
    description: "Событие, дата и призыв к действию",
    layout: "event_ticket",
    recommendedTheses: { min: 1, max: 3 },
  },
  {
    key: "case_study",
    name: "Кейс",
    description: "Задача, решение и результат",
    layout: "case_flow",
    recommendedTheses: { min: 3, max: 3 },
  },
] as const;

export type LegalVisualAssetReference = {
  assetId: string;
  alt: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  sha256: string;
};

export type LegalVisualSemanticColors = {
  background: string;
  surface: string;
  text: string;
  mutedText: string;
  accent: string;
  critical: string;
};

export type LegalVisualBrandKit = {
  name: string;
  logo: LegalVisualAssetReference | null;
  colors: LegalVisualSemanticColors;
  allowedFonts: LegalVisualFontKey[];
  font: LegalVisualFontKey;
  signature: string;
};

export type LegalVisualCta = {
  label: string;
  url: string | null;
};

export type LegalVisualCard = {
  id: string;
  order: number;
  role: LegalVisualCardRole;
  template: LegalVisualTemplateKey;
  eyebrow: string;
  title: string;
  theses: string[];
  emphasis: string;
  image: LegalVisualAssetReference | null;
  cta: LegalVisualCta | null;
  sourceNote: string;
};

export type LegalVisualConfig = {
  schemaVersion: 1;
  id: string;
  projectId: string;
  revision: number;
  name: string;
  format: LegalVisualFormat;
  brand: LegalVisualBrandKit;
  cards: LegalVisualCard[];
};

export type LegalVisualValidationIssue = {
  path: string;
  message: string;
};

export class LegalVisualValidationError extends Error {
  readonly issues: LegalVisualValidationIssue[];

  constructor(issues: LegalVisualValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "LegalVisualValidationError";
    this.issues = issues;
  }
}

const IDENTIFIER_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,127}$/u;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;
const HTTP_URL_PATTERN = /^https:\/\/[^\s]+$/iu;

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, path: string, issues: LegalVisualValidationIssue[]): AnyRecord {
  if (isRecord(value)) return value;
  issues.push({ path, message: "Ожидался объект" });
  return {};
}

function stringAt(
  value: unknown,
  path: string,
  issues: LegalVisualValidationIssue[],
  options: { min?: number; max: number; pattern?: RegExp } = { max: 1_000 },
) {
  if (typeof value !== "string") {
    issues.push({ path, message: "Ожидалась строка" });
    return "";
  }
  const min = options.min ?? 0;
  if (value.length < min) issues.push({ path, message: `Минимум ${min} зн.` });
  if (value.length > options.max) issues.push({ path, message: `Максимум ${options.max} зн.` });
  if (options.pattern && !options.pattern.test(value)) {
    issues.push({ path, message: "Недопустимый формат" });
  }
  return value;
}

function integerAt(
  value: unknown,
  path: string,
  issues: LegalVisualValidationIssue[],
  min: number,
  max: number,
) {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    issues.push({ path, message: `Ожидалось целое число от ${min} до ${max}` });
    return min;
  }
  return value as number;
}

function enumAt<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  issues: LegalVisualValidationIssue[],
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  issues.push({ path, message: `Допустимые значения: ${allowed.join(", ")}` });
  return allowed[0];
}

function assetAt(
  value: unknown,
  path: string,
  issues: LegalVisualValidationIssue[],
): LegalVisualAssetReference | null {
  if (value === null || value === undefined) return null;
  const record = recordAt(value, path, issues);
  const mimeType = enumAt(
    record.mimeType,
    ["image/jpeg", "image/png", "image/webp"] as const,
    `${path}.mimeType`,
    issues,
  );
  return {
    assetId: stringAt(record.assetId, `${path}.assetId`, issues, {
      min: 1,
      max: 128,
      pattern: IDENTIFIER_PATTERN,
    }),
    alt: stringAt(record.alt, `${path}.alt`, issues, { max: 240 }),
    mimeType,
    width: integerAt(record.width, `${path}.width`, issues, 1, 20_000),
    height: integerAt(record.height, `${path}.height`, issues, 1, 20_000),
    sha256: stringAt(record.sha256, `${path}.sha256`, issues, {
      min: 64,
      max: 64,
      pattern: SHA256_PATTERN,
    }).toLowerCase(),
  };
}

function colorsAt(
  value: unknown,
  path: string,
  issues: LegalVisualValidationIssue[],
): LegalVisualSemanticColors {
  const record = recordAt(value, path, issues);
  const read = (key: keyof LegalVisualSemanticColors) =>
    stringAt(record[key], `${path}.${key}`, issues, {
      min: 7,
      max: 7,
      pattern: HEX_COLOR_PATTERN,
    }).toLowerCase();
  return {
    background: read("background"),
    surface: read("surface"),
    text: read("text"),
    mutedText: read("mutedText"),
    accent: read("accent"),
    critical: read("critical"),
  };
}

function brandAt(
  value: unknown,
  path: string,
  issues: LegalVisualValidationIssue[],
): LegalVisualBrandKit {
  const record = recordAt(value, path, issues);
  const allowedFontsValue = Array.isArray(record.allowedFonts) ? record.allowedFonts : [];
  if (!Array.isArray(record.allowedFonts)) {
    issues.push({ path: `${path}.allowedFonts`, message: "Ожидался список шрифтов" });
  }
  const allowedFonts = allowedFontsValue.map((font, index) =>
    enumAt(font, LEGAL_VISUAL_FONT_KEYS, `${path}.allowedFonts.${index}`, issues)
  );
  if (allowedFonts.length === 0) {
    issues.push({ path: `${path}.allowedFonts`, message: "Нужен хотя бы один разрешённый шрифт" });
  }
  if (new Set(allowedFonts).size !== allowedFonts.length) {
    issues.push({ path: `${path}.allowedFonts`, message: "Шрифты не должны повторяться" });
  }
  const font = enumAt(record.font, LEGAL_VISUAL_FONT_KEYS, `${path}.font`, issues);
  if (!allowedFonts.includes(font)) {
    issues.push({ path: `${path}.font`, message: "Активный шрифт должен входить в разрешённые" });
  }
  return {
    name: stringAt(record.name, `${path}.name`, issues, { min: 1, max: 100 }),
    logo: assetAt(record.logo, `${path}.logo`, issues),
    colors: colorsAt(record.colors, `${path}.colors`, issues),
    allowedFonts,
    font,
    signature: stringAt(record.signature, `${path}.signature`, issues, { max: 160 }),
  };
}

function ctaAt(
  value: unknown,
  path: string,
  issues: LegalVisualValidationIssue[],
): LegalVisualCta | null {
  if (value === null || value === undefined) return null;
  const record = recordAt(value, path, issues);
  const url = record.url === null || record.url === undefined
    ? null
    : stringAt(record.url, `${path}.url`, issues, { max: 2_048, pattern: HTTP_URL_PATTERN });
  return {
    label: stringAt(record.label, `${path}.label`, issues, { min: 1, max: 400 }),
    url,
  };
}

function cardAt(
  value: unknown,
  index: number,
  issues: LegalVisualValidationIssue[],
): LegalVisualCard {
  const path = `cards.${index}`;
  const record = recordAt(value, path, issues);
  const thesesValue = Array.isArray(record.theses) ? record.theses : [];
  if (!Array.isArray(record.theses)) {
    issues.push({ path: `${path}.theses`, message: "Ожидался список тезисов" });
  }
  if (thesesValue.length > 10) {
    issues.push({ path: `${path}.theses`, message: "Допускается не более 10 тезисов" });
  }
  return {
    id: stringAt(record.id, `${path}.id`, issues, {
      min: 1,
      max: 128,
      pattern: IDENTIFIER_PATTERN,
    }),
    order: integerAt(record.order, `${path}.order`, issues, 1, 7),
    role: enumAt(record.role, LEGAL_VISUAL_CARD_ROLES, `${path}.role`, issues),
    template: enumAt(record.template, LEGAL_VISUAL_TEMPLATE_KEYS, `${path}.template`, issues),
    eyebrow: stringAt(record.eyebrow, `${path}.eyebrow`, issues, { max: 160 }),
    title: stringAt(record.title, `${path}.title`, issues, { min: 1, max: 1_200 }),
    theses: thesesValue.slice(0, 10).map((thesis, thesisIndex) =>
      stringAt(thesis, `${path}.theses.${thesisIndex}`, issues, { min: 1, max: 1_600 })
    ),
    emphasis: stringAt(record.emphasis, `${path}.emphasis`, issues, { max: 320 }),
    image: assetAt(record.image, `${path}.image`, issues),
    cta: ctaAt(record.cta, `${path}.cta`, issues),
    sourceNote: stringAt(record.sourceNote, `${path}.sourceNote`, issues, { max: 500 }),
  };
}

/**
 * Validates untrusted API/JSON data and returns a fresh, serializable model.
 * Unknown properties are intentionally discarded so they cannot reach SVG.
 */
export function validateLegalVisualConfig(value: unknown): LegalVisualConfig {
  const issues: LegalVisualValidationIssue[] = [];
  const record = recordAt(value, "$", issues);
  if (record.schemaVersion !== 1) {
    issues.push({ path: "schemaVersion", message: "Поддерживается только версия 1" });
  }
  const cardsValue = Array.isArray(record.cards) ? record.cards : [];
  if (!Array.isArray(record.cards)) {
    issues.push({ path: "cards", message: "Ожидался список карточек" });
  }
  if (cardsValue.length < 3 || cardsValue.length > 7) {
    issues.push({ path: "cards", message: "Карусель должна содержать от 3 до 7 карточек" });
  }
  const cards = cardsValue.slice(0, 7).map((card, index) => cardAt(card, index, issues));
  if (new Set(cards.map((card) => card.id)).size !== cards.length) {
    issues.push({ path: "cards", message: "Идентификаторы карточек не должны повторяться" });
  }
  for (let index = 0; index < cards.length; index += 1) {
    if (cards[index].order !== index + 1) {
      issues.push({
        path: `cards.${index}.order`,
        message: "Порядок должен быть непрерывным и совпадать с позицией карточки",
      });
    }
  }

  const config: LegalVisualConfig = {
    schemaVersion: 1,
    id: stringAt(record.id, "id", issues, {
      min: 1,
      max: 128,
      pattern: IDENTIFIER_PATTERN,
    }),
    projectId: stringAt(record.projectId, "projectId", issues, {
      min: 1,
      max: 128,
      pattern: IDENTIFIER_PATTERN,
    }),
    revision: integerAt(record.revision, "revision", issues, 1, 2_147_483_647),
    name: stringAt(record.name, "name", issues, { min: 1, max: 160 }),
    format: enumAt(record.format, LEGAL_VISUAL_FORMATS, "format", issues),
    brand: brandAt(record.brand, "brand", issues),
    cards,
  };
  if (issues.length > 0) throw new LegalVisualValidationError(issues);
  return config;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

export function serializeLegalVisualConfig(config: LegalVisualConfig) {
  return JSON.stringify(stableValue(validateLegalVisualConfig(config)));
}

export function deserializeLegalVisualConfig(serialized: string) {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new LegalVisualValidationError([{ path: "$", message: "Некорректный JSON" }]);
  }
  return validateLegalVisualConfig(value);
}

export function getLegalVisualTemplate(key: LegalVisualTemplateKey) {
  return LEGAL_VISUAL_TEMPLATES.find((template) => template.key === key)!;
}
