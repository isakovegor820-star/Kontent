import { type LegalVisualAssetReference, type LegalVisualConfig, type LegalVisualFormat } from "./legal-visual-model.mjs";
export type LegalVisualDimensions = {
    width: number;
    height: number;
    safeArea: {
        top: number;
        right: number;
        bottom: number;
        left: number;
    };
};
export declare const LEGAL_VISUAL_DIMENSIONS: Record<LegalVisualFormat, LegalVisualDimensions>;
export type LegalVisualWarningCode = "title_overflow" | "theses_overflow" | "emphasis_overflow" | "cta_overflow" | "signature_overflow" | "safe_area_violation" | "low_contrast" | "template_content_mismatch" | "sequence_hook_missing" | "sequence_cta_missing" | "asset_unresolved" | "asset_hash_mismatch" | "asset_invalid";
export type LegalVisualLayoutWarning = {
    id: string;
    code: LegalVisualWarningCode;
    severity: "error" | "warning";
    cardId: string | null;
    field: string;
    message: string;
    actual: number | null;
    limit: number | null;
};
export declare class LegalVisualRenderBlockedError extends Error {
    readonly warnings: LegalVisualLayoutWarning[];
    constructor(warnings: LegalVisualLayoutWarning[]);
}
export type LegalVisualResolvedAsset = {
    data: Buffer | Uint8Array | ArrayBuffer;
    mimeType: "image/jpeg" | "image/png" | "image/webp";
};
export type LegalVisualAssetResolver = (reference: LegalVisualAssetReference) => Promise<LegalVisualResolvedAsset | null>;
export type RenderLegalVisualOptions = {
    assetResolver?: LegalVisualAssetResolver;
    /** Only previews may opt in. Export and publication must keep the default. */
    allowUnsafeLayout?: boolean;
};
export type RenderedLegalVisualCard = {
    cardId: string;
    order: number;
    width: number;
    height: number;
    mimeType: "image/png";
    png: Buffer;
    sha256: string;
    warnings: LegalVisualLayoutWarning[];
};
export type RenderedLegalVisualCarousel = {
    configSnapshot: string;
    configSha256: string;
    cards: RenderedLegalVisualCard[];
    warnings: LegalVisualLayoutWarning[];
};
export declare function escapeLegalVisualXml(value: string): string;
/** Performs the exact same deterministic fit checks used by the renderer. */
export declare function inspectLegalVisualConfig(value: LegalVisualConfig): LegalVisualLayoutWarning[];
/**
 * Builds inspectable SVG source. Only validated model data may enter this
 * function; every user-controlled text node is XML-escaped.
 */
export declare function buildLegalVisualCardSvg(value: LegalVisualConfig, cardId: string, dataUrls?: ReadonlyMap<string, string>): string;
export declare function renderLegalVisualCarousel(value: LegalVisualConfig, options?: RenderLegalVisualOptions): Promise<RenderedLegalVisualCarousel>;
