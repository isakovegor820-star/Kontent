import { createHash } from "node:crypto";
import sharp from "sharp";
import { getLegalVisualTemplate, serializeLegalVisualConfig, validateLegalVisualConfig, } from "./legal-visual-model.mjs";
export const LEGAL_VISUAL_DIMENSIONS = {
    "1:1": {
        width: 1_080,
        height: 1_080,
        safeArea: { top: 84, right: 84, bottom: 84, left: 84 },
    },
    "4:5": {
        width: 1_080,
        height: 1_350,
        safeArea: { top: 92, right: 84, bottom: 96, left: 84 },
    },
    "9:16": {
        width: 1_080,
        height: 1_920,
        // Keeps story UI and common device cut-outs away from meaningful content.
        safeArea: { top: 176, right: 76, bottom: 204, left: 76 },
    },
};
export class LegalVisualRenderBlockedError extends Error {
    warnings;
    constructor(warnings) {
        super("Экспорт заблокирован: исправьте переполнение или небезопасную область");
        this.name = "LegalVisualRenderBlockedError";
        this.warnings = warnings;
    }
}
const FONT_FAMILIES = {
    "aurora-sans": "Arial, DejaVu Sans, sans-serif",
    "legal-serif": "Georgia, DejaVu Serif, serif",
    "technical-mono": "SFMono-Regular, DejaVu Sans Mono, monospace",
};
const TEMPLATE_BODY_FACTORS = {
    what_changed: 0.84,
    three_actions: 0.83,
    deadlines: 0.78,
    business_mistake: 0.82,
    court_holding: 0.9,
    myth_fact: 0.75,
    checklist: 0.92,
    question_answer: 0.9,
    key_number: 0.72,
    announcement: 0.78,
    case_study: 0.78,
};
function layoutLimits(format, template) {
    const story = format === "9:16";
    const portrait = format === "4:5";
    const factor = TEMPLATE_BODY_FACTORS[template];
    const titleWidth = template === "key_number" ? 660 : template === "myth_fact" ? 780 : 900;
    const bodyWidth = Math.round((story ? 900 : 912) * factor);
    return {
        titleWidth,
        titleFontSize: story ? 78 : portrait ? 74 : 68,
        titleMaxLines: story ? 4 : 3,
        bodyFontSize: story ? 42 : portrait ? 38 : 34,
        bodyWidth,
        bodyMaxLines: story ? 15 : portrait ? 11 : 8,
        thesisMaxLines: story ? 4 : portrait ? 3 : 2,
        emphasisFontSize: story ? 132 : portrait ? 118 : 104,
        emphasisMaxLines: template === "key_number" ? 2 : 1,
        ctaFontSize: story ? 34 : 31,
        ctaMaxLines: 2,
    };
}
export function escapeLegalVisualXml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}
function characterUnits(character) {
    if (/\s/u.test(character))
        return 0.34;
    if (/[.,:;!|ilI1'’`]/u.test(character))
        return 0.35;
    if (/[MWЖЩШЮФ@%]/u.test(character))
        return 0.98;
    if (/\p{Lu}/u.test(character))
        return 0.72;
    if (/\p{N}/u.test(character))
        return 0.61;
    if (/[-–—()\[\]{}«»?]/u.test(character))
        return 0.5;
    // Emoji and symbols are conservatively treated as full-width.
    if (!/[\p{L}\p{M}]/u.test(character))
        return 1;
    return 0.59;
}
function textUnits(value) {
    return Array.from(value).reduce((sum, character) => sum + characterUnits(character), 0);
}
function splitLongToken(token, maxUnits) {
    const chunks = [];
    let chunk = "";
    let units = 0;
    for (const character of Array.from(token)) {
        const nextUnits = characterUnits(character);
        if (chunk && units + nextUnits > maxUnits) {
            chunks.push(chunk);
            chunk = character;
            units = nextUnits;
        }
        else {
            chunk += character;
            units += nextUnits;
        }
    }
    if (chunk)
        chunks.push(chunk);
    return chunks;
}
function allWrappedLines(value, maxWidth, fontSize) {
    const maxUnits = Math.max(2, maxWidth / fontSize);
    const lines = [];
    for (const paragraph of value.replace(/\r\n?/gu, "\n").split("\n")) {
        if (!paragraph.trim()) {
            lines.push("");
            continue;
        }
        const tokens = paragraph.trim().split(/\s+/u).flatMap((token) => textUnits(token) > maxUnits ? splitLongToken(token, maxUnits) : [token]);
        let line = "";
        for (const token of tokens) {
            const candidate = line ? `${line} ${token}` : token;
            if (line && textUnits(candidate) > maxUnits) {
                lines.push(line);
                line = token;
            }
            else {
                line = candidate;
            }
        }
        if (line)
            lines.push(line);
    }
    return lines.length > 0 ? lines : [""];
}
function wrapText(value, maxWidth, fontSize, maxLines) {
    const allLines = allWrappedLines(value, maxWidth, fontSize);
    const visible = allLines.slice(0, maxLines);
    if (allLines.length > maxLines && visible.length > 0) {
        const lastIndex = visible.length - 1;
        let last = visible[lastIndex].replace(/[.,;:!?\s]+$/u, "");
        const maxUnits = Math.max(2, maxWidth / fontSize);
        while (last && textUnits(`${last}…`) > maxUnits)
            last = Array.from(last).slice(0, -1).join("");
        visible[lastIndex] = `${last}…`;
    }
    return { lines: visible, totalLines: allLines.length, overflow: allLines.length > maxLines };
}
function warning(code, severity, cardId, field, message, actual = null, limit = null) {
    return {
        id: `${cardId ?? "carousel"}:${field}:${code}`,
        code,
        severity,
        cardId,
        field,
        message,
        actual,
        limit,
    };
}
function colorChannels(hex) {
    return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}
function relativeLuminance(hex) {
    const channels = colorChannels(hex).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrastRatio(left, right) {
    const a = relativeLuminance(left);
    const b = relativeLuminance(right);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function inspectCard(config, card) {
    const limits = layoutLimits(config.format, card.template);
    const warnings = [];
    const title = wrapText(card.title, limits.titleWidth, limits.titleFontSize, limits.titleMaxLines);
    if (title.overflow) {
        warnings.push(warning("title_overflow", "error", card.id, "title", "Заголовок не помещается в шаблон", title.totalLines, limits.titleMaxLines));
    }
    let totalBodyLines = 0;
    let thesisOverflow = false;
    for (let index = 0; index < card.theses.length; index += 1) {
        const wrapped = wrapText(card.theses[index], limits.bodyWidth, limits.bodyFontSize, limits.thesisMaxLines);
        totalBodyLines += wrapped.totalLines;
        if (wrapped.overflow)
            thesisOverflow = true;
    }
    if (thesisOverflow || totalBodyLines > limits.bodyMaxLines) {
        warnings.push(warning("theses_overflow", "error", card.id, "theses", "Тезисы выходят за доступную область", totalBodyLines, limits.bodyMaxLines));
    }
    if (card.emphasis) {
        const emphasis = wrapText(card.emphasis, limits.bodyWidth, limits.emphasisFontSize, limits.emphasisMaxLines);
        if (emphasis.overflow) {
            warnings.push(warning("emphasis_overflow", "error", card.id, "emphasis", "Акцент не помещается в выделенную область", emphasis.totalLines, limits.emphasisMaxLines));
        }
    }
    if (card.cta) {
        const cta = wrapText(card.cta.label, 740, limits.ctaFontSize, limits.ctaMaxLines);
        if (cta.overflow) {
            warnings.push(warning("cta_overflow", "error", card.id, "cta.label", "Призыв к действию слишком длинный", cta.totalLines, limits.ctaMaxLines));
        }
    }
    const template = getLegalVisualTemplate(card.template);
    if (card.theses.length < template.recommendedTheses.min ||
        card.theses.length > template.recommendedTheses.max) {
        warnings.push(warning("template_content_mismatch", "warning", card.id, "theses", `Для шаблона «${template.name}» лучше ${template.recommendedTheses.min}–${template.recommendedTheses.max} тезиса`, card.theses.length, template.recommendedTheses.max));
    }
    if (warnings.some((item) => item.severity === "error")) {
        warnings.push(warning("safe_area_violation", "error", card.id, "layout", "Часть текста может выйти за безопасную область"));
    }
    return warnings;
}
/** Performs the exact same deterministic fit checks used by the renderer. */
export function inspectLegalVisualConfig(value) {
    const config = validateLegalVisualConfig(value);
    const warnings = config.cards.flatMap((card) => inspectCard(config, card));
    const { colors, signature } = config.brand;
    if (contrastRatio(colors.text, colors.background) < 4.5) {
        warnings.push(warning("low_contrast", "error", null, "brand.colors.text", "Контраст основного текста и фона ниже 4,5:1"));
    }
    if (contrastRatio(colors.text, colors.surface) < 4.5) {
        warnings.push(warning("low_contrast", "error", null, "brand.colors.surface", "Контраст текста на дополнительном фоне ниже 4,5:1"));
    }
    const signatureLines = allWrappedLines(signature, 600, 24).length;
    if (signatureLines > 2) {
        warnings.push(warning("signature_overflow", "error", null, "brand.signature", "Подпись бренда не помещается в нижнюю область", signatureLines, 2));
    }
    return warnings.sort((left, right) => left.id.localeCompare(right.id, "en"));
}
function svgText(lines, options) {
    if (lines.length === 0)
        return "";
    const lineHeight = options.lineHeight ?? Math.round(options.fontSize * 1.2);
    const tspans = lines.map((line, index) => `<tspan x="${options.x}" dy="${index === 0 ? 0 : lineHeight}">${escapeLegalVisualXml(line)}</tspan>`).join("");
    return `<text x="${options.x}" y="${options.y}" fill="${options.fill}" font-family="${options.fontFamily}" font-size="${options.fontSize}" font-weight="${options.fontWeight ?? 500}" text-anchor="${options.anchor ?? "start"}" letter-spacing="${options.letterSpacing ?? 0}">${tspans}</text>`;
}
function imageFrame(reference, dataUrls, x, y, width, height, colors) {
    const radius = 28;
    const dataUrl = reference ? dataUrls.get(reference.assetId) : null;
    const frame = `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${colors.surface}" stroke="${colors.mutedText}" stroke-opacity="0.35" stroke-width="2"/>`;
    if (reference && dataUrl) {
        return `<defs><clipPath id="visual-image-clip"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}"/></clipPath></defs>${frame}<image href="${dataUrl}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" clip-path="url(#visual-image-clip)"/>`;
    }
    const label = reference?.alt || "Место для изображения";
    const wrapped = wrapText(label, width - 96, 25, 3);
    return `${frame}<path d="M ${x + width / 2 - 34} ${y + height / 2 - 20} l 24 -24 28 32 22 -18 38 46 h -112 z" fill="${colors.mutedText}" fill-opacity="0.32"/>${svgText(wrapped.lines, {
        x: x + width / 2,
        y: y + height / 2 + 74,
        fontSize: 25,
        fill: colors.mutedText,
        fontFamily: FONT_FAMILIES["aurora-sans"],
        anchor: "middle",
    })}`;
}
function commonHeader(context, options = {}) {
    const { card, dimensions, colors, fontFamily, limits } = context;
    const safe = dimensions.safeArea;
    const title = wrapText(card.title, limits.titleWidth, limits.titleFontSize, limits.titleMaxLines);
    const eyebrow = card.eyebrow || getLegalVisualTemplate(card.template).name;
    const titleY = options.titleAfter ?? safe.top + 118;
    return [
        svgText([eyebrow.toLocaleUpperCase("ru-RU")], {
            x: safe.left,
            y: safe.top + 30,
            fontSize: 25,
            fill: colors.accent,
            fontFamily,
            fontWeight: 700,
            letterSpacing: 1.5,
        }),
        svgText(title.lines, {
            x: safe.left,
            y: titleY,
            fontSize: limits.titleFontSize,
            lineHeight: Math.round(limits.titleFontSize * 1.05),
            fill: colors.text,
            fontFamily,
            fontWeight: 760,
            letterSpacing: -1.6,
        }),
    ].join("");
}
function visibleThesisLines(context, thesis, width, maxLines) {
    return wrapText(thesis, width, context.limits.bodyFontSize, maxLines ?? context.limits.thesisMaxLines).lines;
}
function renderChangeSplit(context) {
    const { dimensions, colors, fontFamily, card } = context;
    const top = dimensions.height === 1_080 ? 440 : dimensions.height === 1_350 ? 500 : 690;
    const height = dimensions.height - dimensions.safeArea.bottom - top - 118;
    const columnWidth = 438;
    const parts = card.theses.length >= 2 ? card.theses : ["Прежнее правило", "Новое правило"];
    return `${commonHeader(context)}
    <rect x="84" y="${top}" width="${columnWidth}" height="${height}" rx="30" fill="${colors.surface}"/>
    <rect x="558" y="${top}" width="${columnWidth}" height="${height}" rx="30" fill="${colors.accent}" fill-opacity="0.12" stroke="${colors.accent}" stroke-width="3"/>
    ${svgText(["БЫЛО"], { x: 122, y: top + 54, fontSize: 23, fill: colors.mutedText, fontFamily, fontWeight: 700, letterSpacing: 2 })}
    ${svgText(visibleThesisLines(context, parts[0], columnWidth - 76, 4), { x: 122, y: top + 126, fontSize: context.limits.bodyFontSize, fill: colors.text, fontFamily, fontWeight: 560 })}
    ${svgText(["СТАЛО"], { x: 596, y: top + 54, fontSize: 23, fill: colors.accent, fontFamily, fontWeight: 700, letterSpacing: 2 })}
    ${svgText(visibleThesisLines(context, parts.slice(1).join(" "), columnWidth - 76, 5), { x: 596, y: top + 126, fontSize: context.limits.bodyFontSize, fill: colors.text, fontFamily, fontWeight: 620 })}`;
}
function renderNumberedSteps(context) {
    const { dimensions, colors, fontFamily, card } = context;
    const top = dimensions.height === 1_080 ? 430 : dimensions.height === 1_350 ? 505 : 700;
    const available = dimensions.height - dimensions.safeArea.bottom - top - 110;
    const rowHeight = Math.min(190, available / 3);
    const theses = [...card.theses, "Добавьте первый шаг", "Добавьте второй шаг", "Добавьте третий шаг"].slice(0, 3);
    return `${commonHeader(context)}${theses.map((thesis, index) => {
        const y = top + index * rowHeight;
        return `<circle cx="132" cy="${y + 54}" r="43" fill="${colors.accent}"/>
      ${svgText([String(index + 1)], { x: 132, y: y + 68, fontSize: 38, fill: colors.background, fontFamily, fontWeight: 800, anchor: "middle" })}
      ${svgText(visibleThesisLines(context, thesis, 790, 3), { x: 208, y: y + 48, fontSize: context.limits.bodyFontSize, fill: colors.text, fontFamily, fontWeight: 570 })}
      ${index < 2 ? `<line x1="132" y1="${y + 102}" x2="132" y2="${y + rowHeight - 8}" stroke="${colors.accent}" stroke-opacity="0.36" stroke-width="4"/>` : ""}`;
    }).join("")}`;
}
function renderTimeline(context) {
    const { dimensions, colors, fontFamily, card } = context;
    const top = dimensions.height === 1_080 ? 450 : dimensions.height === 1_350 ? 520 : 720;
    const bottom = dimensions.height - dimensions.safeArea.bottom - 130;
    const theses = card.theses.slice(0, 4);
    const gap = theses.length > 1 ? (bottom - top) / (theses.length - 1) : 0;
    return `${commonHeader(context)}
    <line x1="154" y1="${top}" x2="154" y2="${bottom}" stroke="${colors.accent}" stroke-width="5"/>
    ${theses.map((thesis, index) => {
        const y = top + gap * index;
        return `<circle cx="154" cy="${y}" r="18" fill="${colors.background}" stroke="${colors.accent}" stroke-width="7"/>
        ${svgText([String(index + 1).padStart(2, "0")], { x: 204, y: y + 10, fontSize: 24, fill: colors.accent, fontFamily, fontWeight: 760 })}
        ${svgText(visibleThesisLines(context, thesis, 690, 3), { x: 278, y: y + 10, fontSize: context.limits.bodyFontSize, fill: colors.text, fontFamily, fontWeight: 560 })}`;
    }).join("")}`;
}
function renderRiskNotice(context) {
    const { dimensions, colors, fontFamily, card } = context;
    const top = dimensions.height === 1_080 ? 430 : dimensions.height === 1_350 ? 500 : 690;
    const risk = card.theses[0] || "Опишите риск";
    const action = card.theses.slice(1).join(" ") || "Добавьте безопасное действие";
    return `${commonHeader(context)}
    <path d="M 84 ${top + 38} L 124 ${top} H 996 V ${top + 208} H 84 Z" fill="${colors.critical}" fill-opacity="0.13"/>
    <path d="M 84 ${top + 38} L 124 ${top} H 164 L 84 ${top + 80} Z" fill="${colors.critical}"/>
    ${svgText(["РИСК"], { x: 138, y: top + 68, fontSize: 24, fill: colors.critical, fontFamily, fontWeight: 800, letterSpacing: 2 })}
    ${svgText(visibleThesisLines(context, risk, 790, 3), { x: 138, y: top + 130, fontSize: context.limits.bodyFontSize, fill: colors.text, fontFamily, fontWeight: 640 })}
    <rect x="84" y="${top + 250}" width="912" height="${Math.max(220, dimensions.height - dimensions.safeArea.bottom - top - 390)}" rx="30" fill="${colors.surface}"/>
    ${svgText(["ЧТО СДЕЛАТЬ"], { x: 132, y: top + 310, fontSize: 24, fill: colors.accent, fontFamily, fontWeight: 800, letterSpacing: 1.5 })}
    ${svgText(visibleThesisLines(context, action, 800, 5), { x: 132, y: top + 380, fontSize: context.limits.bodyFontSize, fill: colors.text, fontFamily, fontWeight: 560 })}`;
}
function renderJudicialQuote(context) {
    const { dimensions, colors, fontFamily, card } = context;
    const top = dimensions.height === 1_080 ? 430 : dimensions.height === 1_350 ? 500 : 700;
    const quote = card.theses.join(" ") || "Добавьте подтверждённый вывод суда";
    const quoteFont = context.limits.bodyFontSize + 6;
    return `${commonHeader(context)}
    ${svgText(["§"], { x: 92, y: top + 90, fontSize: 138, fill: colors.accent, fontFamily: FONT_FAMILIES["legal-serif"], fontWeight: 700 })}
    <line x1="238" y1="${top}" x2="238" y2="${dimensions.height - dimensions.safeArea.bottom - 120}" stroke="${colors.accent}" stroke-width="5"/>
    ${svgText(wrapText(quote, 680, quoteFont, context.config.format === "9:16" ? 9 : 6).lines, { x: 294, y: top + 48, fontSize: quoteFont, lineHeight: Math.round(quoteFont * 1.3), fill: colors.text, fontFamily: FONT_FAMILIES["legal-serif"], fontWeight: 520 })}
    ${card.sourceNote ? svgText(wrapText(card.sourceNote, 650, 24, 2).lines, { x: 294, y: dimensions.height - dimensions.safeArea.bottom - 106, fontSize: 24, fill: colors.mutedText, fontFamily, fontWeight: 520 }) : ""}`;
}
function renderMythFact(context) {
    const { dimensions, colors, fontFamily, card } = context;
    const top = dimensions.height === 1_080 ? 420 : dimensions.height === 1_350 ? 500 : 690;
    const blockHeight = Math.max(220, (dimensions.height - dimensions.safeArea.bottom - top - 140) / 2);
    const myth = card.theses[0] || "Распространённый миф";
    const fact = card.theses[1] || "Проверенный факт";
    return `${commonHeader(context)}
    <rect x="84" y="${top}" width="912" height="${blockHeight}" rx="30" fill="${colors.surface}"/>
    <path d="M 116 ${top + 52} l 44 -44 l 44 44 l -44 44 z" fill="${colors.critical}"/>
    ${svgText(["МИФ"], { x: 230, y: top + 67, fontSize: 25, fill: colors.critical, fontFamily, fontWeight: 800, letterSpacing: 2 })}
    ${svgText(visibleThesisLines(context, myth, 790, 4), { x: 132, y: top + 142, fontSize: context.limits.bodyFontSize, fill: colors.text, fontFamily, fontWeight: 560 })}
    <rect x="84" y="${top + blockHeight + 28}" width="912" height="${blockHeight}" rx="30" fill="${colors.accent}" fill-opacity="0.12" stroke="${colors.accent}" stroke-width="3"/>
    <circle cx="160" cy="${top + blockHeight + 94}" r="42" fill="${colors.accent}"/>
    <path d="M 141 ${top + blockHeight + 94} l 13 14 l 28 -32" fill="none" stroke="${colors.background}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    ${svgText(["ФАКТ"], { x: 230, y: top + blockHeight + 103, fontSize: 25, fill: colors.accent, fontFamily, fontWeight: 800, letterSpacing: 2 })}
    ${svgText(visibleThesisLines(context, fact, 790, 4), { x: 132, y: top + blockHeight + 178, fontSize: context.limits.bodyFontSize, fill: colors.text, fontFamily, fontWeight: 640 })}`;
}
function renderChecklist(context) {
    const { dimensions, colors, fontFamily, card } = context;
    const top = dimensions.height === 1_080 ? 415 : dimensions.height === 1_350 ? 490 : 675;
    const bottom = dimensions.height - dimensions.safeArea.bottom - 120;
    const theses = card.theses.slice(0, 6);
    const rowHeight = Math.min(150, (bottom - top) / Math.max(1, theses.length));
    return `${commonHeader(context)}${theses.map((thesis, index) => {
        const y = top + index * rowHeight;
        return `<rect x="92" y="${y}" width="58" height="58" rx="14" fill="none" stroke="${colors.accent}" stroke-width="4"/>
      <path d="M 107 ${y + 29} l 12 13 l 23 -28" fill="none" stroke="${colors.accent}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      ${svgText(visibleThesisLines(context, thesis, 790, 2), { x: 192, y: y + 41, fontSize: context.limits.bodyFontSize, fill: colors.text, fontFamily, fontWeight: 560 })}`;
    }).join("")}`;
}
function renderQuestionAnswer(context) {
    const { dimensions, colors, fontFamily, card } = context;
    const top = dimensions.height === 1_080 ? 420 : dimensions.height === 1_350 ? 500 : 690;
    const answer = card.theses.join(" ") || "Добавьте краткий и точный ответ";
    return `${commonHeader(context)}
    <circle cx="170" cy="${top + 80}" r="78" fill="${colors.accent}"/>
    ${svgText(["?"], { x: 170, y: top + 111, fontSize: 92, fill: colors.background, fontFamily, fontWeight: 820, anchor: "middle" })}
    ${svgText(["КОРОТКИЙ ОТВЕТ"], { x: 292, y: top + 47, fontSize: 24, fill: colors.accent, fontFamily, fontWeight: 800, letterSpacing: 1.6 })}
    <rect x="260" y="${top + 78}" width="736" height="${Math.max(260, dimensions.height - dimensions.safeArea.bottom - top - 210)}" rx="34" fill="${colors.surface}"/>
    ${svgText(wrapText(answer, 640, context.limits.bodyFontSize + 2, context.config.format === "9:16" ? 8 : 5).lines, { x: 316, y: top + 150, fontSize: context.limits.bodyFontSize + 2, lineHeight: Math.round(context.limits.bodyFontSize * 1.35), fill: colors.text, fontFamily, fontWeight: 570 })}`;
}
function renderKeyNumber(context) {
    const { dimensions, colors, fontFamily, card } = context;
    const top = dimensions.height === 1_080 ? 400 : dimensions.height === 1_350 ? 470 : 650;
    const emphasis = card.emphasis || "01";
    const detail = card.theses.join(" ");
    const numberLines = wrapText(emphasis, 840, context.limits.emphasisFontSize, 2).lines;
    return `${commonHeader(context)}
    <circle cx="820" cy="${top + 180}" r="250" fill="${colors.accent}" fill-opacity="0.1"/>
    ${svgText(numberLines, { x: 84, y: top + 150, fontSize: context.limits.emphasisFontSize, lineHeight: Math.round(context.limits.emphasisFontSize * 0.92), fill: colors.accent, fontFamily, fontWeight: 860, letterSpacing: -4 })}
    <line x1="84" y1="${top + 240}" x2="996" y2="${top + 240}" stroke="${colors.accent}" stroke-width="5"/>
    ${svgText(wrapText(detail, 820, context.limits.bodyFontSize, context.config.format === "9:16" ? 7 : 4).lines, { x: 84, y: top + 320, fontSize: context.limits.bodyFontSize, lineHeight: Math.round(context.limits.bodyFontSize * 1.3), fill: colors.text, fontFamily, fontWeight: 560 })}`;
}
function renderAnnouncement(context) {
    const { dimensions, colors, fontFamily, card } = context;
    const top = dimensions.height === 1_080 ? 420 : dimensions.height === 1_350 ? 500 : 690;
    const emphasis = card.emphasis || "СОБЫТИЕ";
    const imageWidth = context.config.format === "9:16" ? 912 : 400;
    const imageHeight = context.config.format === "9:16" ? 390 : 430;
    const imageX = context.config.format === "9:16" ? 84 : 596;
    const imageY = context.config.format === "9:16" ? top + 260 : top;
    return `${commonHeader(context)}
    <rect x="84" y="${top}" width="${context.config.format === "9:16" ? 912 : 468}" height="214" rx="28" fill="${colors.accent}"/>
    ${svgText(wrapText(emphasis, context.config.format === "9:16" ? 810 : 380, 54, 2).lines, { x: 126, y: top + 82, fontSize: 54, lineHeight: 60, fill: colors.background, fontFamily, fontWeight: 800 })}
    ${context.config.format === "9:16" ? "" : svgText(wrapText(card.theses.join(" "), 430, context.limits.bodyFontSize, 5).lines, { x: 84, y: top + 300, fontSize: context.limits.bodyFontSize, fill: colors.text, fontFamily, fontWeight: 560 })}
    ${imageFrame(card.image, context.dataUrls, imageX, imageY, imageWidth, imageHeight, colors)}
    ${context.config.format === "9:16" ? svgText(wrapText(card.theses.join(" "), 820, context.limits.bodyFontSize, 5).lines, { x: 84, y: imageY + imageHeight + 80, fontSize: context.limits.bodyFontSize, fill: colors.text, fontFamily, fontWeight: 560 }) : ""}`;
}
function renderCaseStudy(context) {
    const { dimensions, colors, fontFamily, card } = context;
    const top = dimensions.height === 1_080 ? 420 : dimensions.height === 1_350 ? 500 : 690;
    const bottom = dimensions.height - dimensions.safeArea.bottom - 120;
    const rowHeight = Math.min(210, (bottom - top) / 3);
    const labels = ["ЗАДАЧА", "РЕШЕНИЕ", "РЕЗУЛЬТАТ"];
    const theses = [...card.theses, "Опишите задачу", "Опишите решение", "Опишите результат"].slice(0, 3);
    return `${commonHeader(context)}${theses.map((thesis, index) => {
        const y = top + index * rowHeight;
        const width = 912 - index * 64;
        const x = 84 + index * 32;
        return `<path d="M ${x} ${y} H ${x + width - 36} L ${x + width} ${y + 36} V ${y + rowHeight - 18} H ${x} Z" fill="${index === 2 ? colors.accent : colors.surface}" fill-opacity="${index === 2 ? 0.16 : 1}"/>
      ${svgText([labels[index]], { x: x + 38, y: y + 52, fontSize: 22, fill: index === 2 ? colors.accent : colors.mutedText, fontFamily, fontWeight: 800, letterSpacing: 1.6 })}
      ${svgText(visibleThesisLines(context, thesis, width - 76, 3), { x: x + 38, y: y + 108, fontSize: context.limits.bodyFontSize, fill: colors.text, fontFamily, fontWeight: index === 2 ? 660 : 550 })}`;
    }).join("")}`;
}
function renderTemplateBody(context) {
    switch (context.card.template) {
        case "what_changed": return renderChangeSplit(context);
        case "three_actions": return renderNumberedSteps(context);
        case "deadlines": return renderTimeline(context);
        case "business_mistake": return renderRiskNotice(context);
        case "court_holding": return renderJudicialQuote(context);
        case "myth_fact": return renderMythFact(context);
        case "checklist": return renderChecklist(context);
        case "question_answer": return renderQuestionAnswer(context);
        case "key_number": return renderKeyNumber(context);
        case "announcement": return renderAnnouncement(context);
        case "case_study": return renderCaseStudy(context);
    }
}
function bestOnAccent(colors) {
    return contrastRatio(colors.background, colors.accent) >= contrastRatio(colors.text, colors.accent)
        ? colors.background
        : colors.text;
}
function footer(context) {
    const { config, card, dimensions, colors, fontFamily, cardIndex, dataUrls } = context;
    const y = dimensions.height - dimensions.safeArea.bottom;
    const signature = wrapText(config.brand.signature || config.brand.name, 600, 24, 2);
    const cta = card.cta
        ? wrapText(card.cta.label, 690, context.limits.ctaFontSize, context.limits.ctaMaxLines)
        : null;
    const ctaHeight = cta
        ? 74 + Math.max(0, cta.lines.length - 1) * (context.limits.ctaFontSize + 8)
        : 0;
    const ctaTop = y - 98 - ctaHeight;
    const signatureY = y - (signature.lines.length > 1 ? 42 : 25);
    const logo = config.brand.logo;
    const logoDataUrl = logo ? dataUrls.get(logo.assetId) : null;
    return `<line x1="${dimensions.safeArea.left}" y1="${y - 78}" x2="${dimensions.width - dimensions.safeArea.right}" y2="${y - 78}" stroke="${colors.mutedText}" stroke-opacity="0.28" stroke-width="2"/>
    ${cta ? `<rect x="84" y="${ctaTop}" width="${Math.min(820, 140 + Math.max(...cta.lines.map(textUnits)) * context.limits.ctaFontSize)}" height="${ctaHeight}" rx="22" fill="${colors.accent}"/>${svgText(cta.lines, { x: 122, y: ctaTop + 47, fontSize: context.limits.ctaFontSize, lineHeight: context.limits.ctaFontSize + 8, fill: bestOnAccent(colors), fontFamily, fontWeight: 720 })}` : ""}
    ${logo && logoDataUrl ? `<image href="${logoDataUrl}" x="${dimensions.safeArea.left}" y="${y - 56}" width="44" height="44" preserveAspectRatio="xMidYMid meet"/>` : `<circle cx="${dimensions.safeArea.left + 20}" cy="${y - 34}" r="19" fill="${colors.accent}"/>`}
    ${svgText(signature.lines, { x: dimensions.safeArea.left + 58, y: signatureY, fontSize: 24, lineHeight: 28, fill: colors.mutedText, fontFamily, fontWeight: 560 })}
    ${svgText([`${cardIndex + 1}/${config.cards.length}`], { x: dimensions.width - dimensions.safeArea.right, y: y - 25, fontSize: 24, fill: colors.mutedText, fontFamily, fontWeight: 650, anchor: "end" })}`;
}
/**
 * Builds inspectable SVG source. Only validated model data may enter this
 * function; every user-controlled text node is XML-escaped.
 */
export function buildLegalVisualCardSvg(value, cardId, dataUrls = new Map()) {
    const config = validateLegalVisualConfig(value);
    const cardIndex = config.cards.findIndex((candidate) => candidate.id === cardId);
    if (cardIndex < 0)
        throw new Error(`Unknown legal visual card: ${cardId}`);
    const card = config.cards[cardIndex];
    const dimensions = LEGAL_VISUAL_DIMENSIONS[config.format];
    const context = {
        config,
        card,
        cardIndex,
        dimensions,
        colors: config.brand.colors,
        fontFamily: FONT_FAMILIES[config.brand.font],
        limits: layoutLimits(config.format, card.template),
        dataUrls,
    };
    const title = `${config.name}: ${card.title}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}" role="img" aria-label="${escapeLegalVisualXml(title)}">
    <title>${escapeLegalVisualXml(title)}</title>
    <rect width="${dimensions.width}" height="${dimensions.height}" fill="${context.colors.background}"/>
    <circle cx="${dimensions.width + 80}" cy="-40" r="360" fill="${context.colors.accent}" fill-opacity="0.06"/>
    ${renderTemplateBody(context)}
    ${footer(context)}
  </svg>`;
}
function toBuffer(value) {
    if (Buffer.isBuffer(value))
        return value;
    if (value instanceof ArrayBuffer)
        return Buffer.from(value);
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
async function resolveAssets(config, resolver) {
    const dataUrls = new Map();
    const warnings = [];
    const references = [
        ...(config.brand.logo ? [config.brand.logo] : []),
        ...config.cards.flatMap((card) => card.image ? [card.image] : []),
    ].filter((reference, index, all) => all.findIndex((candidate) => candidate.assetId === reference.assetId) === index);
    if (!resolver)
        return { dataUrls, warnings };
    for (const reference of references) {
        let resolved = null;
        try {
            resolved = await resolver(reference);
        }
        catch {
            warnings.push(warning("asset_unresolved", "warning", null, `asset.${reference.assetId}`, `Медиафайл «${reference.alt || reference.assetId}» недоступен`));
            continue;
        }
        if (!resolved) {
            warnings.push(warning("asset_unresolved", "warning", null, `asset.${reference.assetId}`, `Медиафайл «${reference.alt || reference.assetId}» недоступен`));
            continue;
        }
        const input = toBuffer(resolved.data);
        if (createHash("sha256").update(input).digest("hex") !== reference.sha256) {
            warnings.push(warning("asset_hash_mismatch", "error", null, `asset.${reference.assetId}`, `Контрольная сумма медиафайла «${reference.alt || reference.assetId}» не совпала`));
            continue;
        }
        try {
            const normalized = await sharp(input, {
                failOn: "error",
                limitInputPixels: 40_000_000,
            })
                .rotate()
                .resize(1_600, 1_600, { fit: "inside", withoutEnlargement: true })
                .png({ compressionLevel: 9, adaptiveFiltering: false })
                .toBuffer();
            dataUrls.set(reference.assetId, `data:image/png;base64,${normalized.toString("base64")}`);
        }
        catch {
            warnings.push(warning("asset_invalid", "error", null, `asset.${reference.assetId}`, `Медиафайл «${reference.alt || reference.assetId}» не удалось декодировать`));
        }
    }
    return { dataUrls, warnings };
}
export async function renderLegalVisualCarousel(value, options = {}) {
    const config = validateLegalVisualConfig(value);
    const configSnapshot = serializeLegalVisualConfig(config);
    const configSha256 = createHash("sha256").update(configSnapshot).digest("hex");
    const layoutWarnings = inspectLegalVisualConfig(config);
    if (!options.allowUnsafeLayout && layoutWarnings.some((item) => item.severity === "error")) {
        throw new LegalVisualRenderBlockedError(layoutWarnings);
    }
    const assets = await resolveAssets(config, options.assetResolver);
    const warnings = [...layoutWarnings, ...assets.warnings].sort((left, right) => left.id.localeCompare(right.id, "en"));
    if (!options.allowUnsafeLayout && warnings.some((item) => item.severity === "error")) {
        throw new LegalVisualRenderBlockedError(warnings);
    }
    const dimensions = LEGAL_VISUAL_DIMENSIONS[config.format];
    const cards = [];
    for (const card of config.cards) {
        const svg = buildLegalVisualCardSvg(config, card.id, assets.dataUrls);
        const png = await sharp(Buffer.from(svg), { density: 144 })
            .resize(dimensions.width, dimensions.height, {
            fit: "fill",
            kernel: sharp.kernel.lanczos3,
        })
            .png({
            compressionLevel: 9,
            adaptiveFiltering: false,
            palette: false,
        })
            .toBuffer();
        cards.push({
            cardId: card.id,
            order: card.order,
            width: dimensions.width,
            height: dimensions.height,
            mimeType: "image/png",
            png,
            sha256: createHash("sha256").update(png).digest("hex"),
            warnings: warnings.filter((item) => item.cardId === null || item.cardId === card.id),
        });
    }
    return { configSnapshot, configSha256, cards, warnings };
}
