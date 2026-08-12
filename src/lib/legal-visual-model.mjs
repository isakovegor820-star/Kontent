export const LEGAL_VISUAL_FORMATS = ["1:1", "4:5", "9:16"];
export const LEGAL_VISUAL_FONT_KEYS = [
    "aurora-sans",
    "legal-serif",
    "technical-mono",
];
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
];
export const LEGAL_VISUAL_CARD_ROLES = [
    "hook",
    "context",
    "audience",
    "actions",
    "deadline",
    "caveat",
    "cta",
];
/**
 * The registry is product data rather than decorative aliases: every entry is
 * backed by a separate renderer layout in `legal-visual-render.ts`.
 */
export const LEGAL_VISUAL_TEMPLATES = [
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
        name: "Разбор ситуации",
        description: "Задача, решение и результат",
        layout: "case_flow",
        recommendedTheses: { min: 3, max: 3 },
    },
];
export class LegalVisualValidationError extends Error {
    issues;
    constructor(issues) {
        super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
        this.name = "LegalVisualValidationError";
        this.issues = issues;
    }
}
const IDENTIFIER_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,127}$/u;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;
const HTTP_URL_PATTERN = /^https:\/\/[^\s]+$/iu;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function recordAt(value, path, issues) {
    if (isRecord(value))
        return value;
    issues.push({ path, message: "Ожидался объект" });
    return {};
}
function stringAt(value, path, issues, options = { max: 1_000 }) {
    if (typeof value !== "string") {
        issues.push({ path, message: "Ожидалась строка" });
        return "";
    }
    const min = options.min ?? 0;
    if (value.length < min)
        issues.push({ path, message: `Минимум ${min} зн.` });
    if (value.length > options.max)
        issues.push({ path, message: `Максимум ${options.max} зн.` });
    if (options.pattern && !options.pattern.test(value)) {
        issues.push({ path, message: "Недопустимый формат" });
    }
    return value;
}
function integerAt(value, path, issues, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
        issues.push({ path, message: `Ожидалось целое число от ${min} до ${max}` });
        return min;
    }
    return value;
}
function enumAt(value, allowed, path, issues) {
    if (typeof value === "string" && allowed.includes(value))
        return value;
    issues.push({ path, message: `Допустимые значения: ${allowed.join(", ")}` });
    return allowed[0];
}
function assetAt(value, path, issues) {
    if (value === null || value === undefined)
        return null;
    const record = recordAt(value, path, issues);
    const mimeType = enumAt(record.mimeType, ["image/jpeg", "image/png", "image/webp"], `${path}.mimeType`, issues);
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
function colorsAt(value, path, issues) {
    const record = recordAt(value, path, issues);
    const read = (key) => stringAt(record[key], `${path}.${key}`, issues, {
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
function brandAt(value, path, issues) {
    const record = recordAt(value, path, issues);
    const allowedFontsValue = Array.isArray(record.allowedFonts) ? record.allowedFonts : [];
    if (!Array.isArray(record.allowedFonts)) {
        issues.push({ path: `${path}.allowedFonts`, message: "Ожидался список шрифтов" });
    }
    const allowedFonts = allowedFontsValue.map((font, index) => enumAt(font, LEGAL_VISUAL_FONT_KEYS, `${path}.allowedFonts.${index}`, issues));
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
function ctaAt(value, path, issues) {
    if (value === null || value === undefined)
        return null;
    const record = recordAt(value, path, issues);
    const url = record.url === null || record.url === undefined
        ? null
        : stringAt(record.url, `${path}.url`, issues, { max: 2_048, pattern: HTTP_URL_PATTERN });
    return {
        label: stringAt(record.label, `${path}.label`, issues, { min: 1, max: 400 }),
        url,
    };
}
function cardAt(value, index, issues) {
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
        theses: thesesValue.slice(0, 10).map((thesis, thesisIndex) => stringAt(thesis, `${path}.theses.${thesisIndex}`, issues, { min: 1, max: 1_600 })),
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
export function validateLegalVisualConfig(value) {
    const issues = [];
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
    if (cards.length > 0 && cards[0].role !== "hook") {
        issues.push({ path: "cards.0.role", message: "Первая карточка должна быть зацепкой" });
    }
    const lastIndex = Math.max(0, cards.length - 1);
    if (cards.length > 0 && cards[lastIndex].role !== "cta") {
        issues.push({ path: `cards.${lastIndex}.role`, message: "Последняя карточка должна завершать сценарий призывом" });
    }
    const roleRanks = new Map(LEGAL_VISUAL_CARD_ROLES.map((role, index) => [role, index]));
    const seenRoles = new Set();
    let previousRoleRank = -1;
    for (let index = 0; index < cards.length; index += 1) {
        const role = cards[index].role;
        const rank = roleRanks.get(role) ?? -1;
        if (seenRoles.has(role)) {
            issues.push({ path: `cards.${index}.role`, message: "Роли карточек не должны повторяться" });
        }
        if (rank <= previousRoleRank) {
            issues.push({ path: `cards.${index}.role`, message: "Сценарий карточек должен развиваться последовательно" });
        }
        seenRoles.add(role);
        previousRoleRank = Math.max(previousRoleRank, rank);
    }
    const config = {
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
    if (issues.length > 0)
        throw new LegalVisualValidationError(issues);
    return config;
}
function stableValue(value) {
    if (Array.isArray(value))
        return value.map(stableValue);
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}
export function serializeLegalVisualConfig(config) {
    return JSON.stringify(stableValue(validateLegalVisualConfig(config)));
}
export function deserializeLegalVisualConfig(serialized) {
    let value;
    try {
        value = JSON.parse(serialized);
    }
    catch {
        throw new LegalVisualValidationError([{ path: "$", message: "Некорректный JSON" }]);
    }
    return validateLegalVisualConfig(value);
}
export function getLegalVisualTemplate(key) {
    return LEGAL_VISUAL_TEMPLATES.find((template) => template.key === key);
}
