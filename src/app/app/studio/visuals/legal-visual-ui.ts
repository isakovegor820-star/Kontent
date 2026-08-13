export const LEGAL_VISUAL_FONT_OPTIONS = [
  { key: "aurora-sans", label: "Современный гротеск" },
  { key: "legal-serif", label: "Юридическая антиква" },
  { key: "technical-mono", label: "Технический моно" },
] as const;

export type LegalVisualFont = typeof LEGAL_VISUAL_FONT_OPTIONS[number]["key"];

export type LegalVisualAssetReference = {
  assetId: string;
  alt: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  sha256: string;
};

export type LegalVisualMediaAsset = {
  id: number;
  fileName: string;
  mimeType: LegalVisualAssetReference["mimeType"];
  sha256: string;
  width: number | null;
  height: number | null;
  metadata: { alt?: string };
};

const FONT_STACKS: Record<LegalVisualFont, string> = {
  "aurora-sans": "Arial, 'DejaVu Sans', sans-serif",
  "legal-serif": "Georgia, 'DejaVu Serif', serif",
  "technical-mono": "SFMono-Regular, 'DejaVu Sans Mono', monospace",
};

export function legalVisualFontFamily(font: LegalVisualFont): string {
  return FONT_STACKS[font];
}

export function mediaAssetToVisualReference(
  asset: LegalVisualMediaAsset,
  fallbackAlt: string,
): LegalVisualAssetReference {
  return {
    assetId: String(asset.id),
    alt: asset.metadata.alt?.normalize("NFC").trim() || fallbackAlt.normalize("NFC").trim(),
    mimeType: asset.mimeType,
    width: asset.width ?? 1,
    height: asset.height ?? 1,
    sha256: asset.sha256.toLowerCase(),
  };
}

export function toggleAllowedVisualFont(input: {
  allowedFonts: LegalVisualFont[];
  activeFont: LegalVisualFont;
  font: LegalVisualFont;
  enabled: boolean;
}): { allowedFonts: LegalVisualFont[]; activeFont: LegalVisualFont } {
  const selected = new Set(input.allowedFonts);
  if (input.enabled) selected.add(input.font);
  else if (selected.size > 1) selected.delete(input.font);

  const allowedFonts = LEGAL_VISUAL_FONT_OPTIONS
    .map((option) => option.key)
    .filter((font) => selected.has(font));
  const normalized = allowedFonts.length > 0 ? allowedFonts : [input.activeFont];
  return {
    allowedFonts: normalized,
    activeFont: normalized.includes(input.activeFont) ? input.activeFont : normalized[0],
  };
}
