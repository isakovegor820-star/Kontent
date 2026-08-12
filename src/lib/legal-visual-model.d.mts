export declare const LEGAL_VISUAL_FORMATS: readonly ["1:1", "4:5", "9:16"];
export type LegalVisualFormat = (typeof LEGAL_VISUAL_FORMATS)[number];
export declare const LEGAL_VISUAL_FONT_KEYS: readonly ["aurora-sans", "legal-serif", "technical-mono"];
export type LegalVisualFontKey = (typeof LEGAL_VISUAL_FONT_KEYS)[number];
export declare const LEGAL_VISUAL_TEMPLATE_KEYS: readonly ["what_changed", "three_actions", "deadlines", "business_mistake", "court_holding", "myth_fact", "checklist", "question_answer", "key_number", "announcement", "case_study"];
export type LegalVisualTemplateKey = (typeof LEGAL_VISUAL_TEMPLATE_KEYS)[number];
export declare const LEGAL_VISUAL_CARD_ROLES: readonly ["hook", "context", "audience", "actions", "deadline", "caveat", "cta"];
export type LegalVisualCardRole = (typeof LEGAL_VISUAL_CARD_ROLES)[number];
export type LegalVisualTemplateDefinition = {
    key: LegalVisualTemplateKey;
    name: string;
    description: string;
    layout: "change_split" | "numbered_steps" | "timeline" | "risk_notice" | "judicial_quote" | "binary_compare" | "check_rows" | "qa_stack" | "number_focus" | "event_ticket" | "case_flow";
    recommendedTheses: {
        min: number;
        max: number;
    };
};
/**
 * The registry is product data rather than decorative aliases: every entry is
 * backed by a separate renderer layout in `legal-visual-render.ts`.
 */
export declare const LEGAL_VISUAL_TEMPLATES: readonly LegalVisualTemplateDefinition[];
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
export declare class LegalVisualValidationError extends Error {
    readonly issues: LegalVisualValidationIssue[];
    constructor(issues: LegalVisualValidationIssue[]);
}
/**
 * Validates untrusted API/JSON data and returns a fresh, serializable model.
 * Unknown properties are intentionally discarded so they cannot reach SVG.
 */
export declare function validateLegalVisualConfig(value: unknown): LegalVisualConfig;
export declare function serializeLegalVisualConfig(config: LegalVisualConfig): string;
export declare function deserializeLegalVisualConfig(serialized: string): LegalVisualConfig;
export declare function getLegalVisualTemplate(key: LegalVisualTemplateKey): LegalVisualTemplateDefinition;
