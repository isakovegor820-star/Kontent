import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("legal visual studio brand-kit interface", () => {
  it("manages the project logo only through project media assets", () => {
    expect(source).toContain('json<{ assets: MediaAsset[] }>("/api/media/assets")');
    expect(source).toContain('json<{ asset: MediaAsset }>("/api/media/assets", { method: "POST", body: form })');
    expect(source).toContain('id="brand-logo"');
    expect(source).toContain('mediaAssetToVisualReference(asset, `Логотип ${brand.name || "проекта"}`)');
    expect(source).not.toContain("data:image/");
    expect(source).not.toContain('type="url" name="logo"');
  });

  it("shows the selected logo and font in both brand and card previews", () => {
    expect(source).toContain('src={`/api/media/assets/${brand.logo.assetId}`}');
    expect(source).toContain('src={`/api/media/assets/${config.brand.logo.assetId}`}');
    expect(source).toContain("fontFamily: legalVisualFontFamily(config.brand.font)");
    expect(source).toContain("Применить стиль проекта");
  });

  it("edits allowed fonts without bypassing the server brand-kit model", () => {
    expect(source).toContain("LEGAL_VISUAL_FONT_OPTIONS.map");
    expect(source).toContain("toggleAllowedVisualFont({");
    expect(source).toContain("allowedFonts: brand.allowedFonts");
    expect(source).toContain('JSON.stringify({ expectedVersion: version, brand })');
    expect(source).toContain("setBrand(result.brand)");
  });

  it("shows carousels and video scripts as two native sections without an internal switch", () => {
    expect(source).toContain('aria-labelledby="carousel-heading"');
    expect(source).toContain('id="carousel-heading"');
    expect(source).toContain('aria-labelledby="video-scripts-heading"');
    expect(source).toContain('id="video-scripts-heading"');
    expect(source).not.toContain('role="tablist"');
    expect(source).not.toContain('role="tabpanel"');
    expect(source).not.toContain('hidden={mode !==');
  });

  it("keeps the new controls touch-sized and reflows them at narrow widths", () => {
    expect(source).toContain('className="w-full sm:w-auto">Загрузить логотип</Button>');
    expect(source).toContain('className="w-full sm:w-auto"');
    expect(source).toContain("min-h-11");
  });

  it("marks the private production brief as a same-origin download in every browser", () => {
    expect(source).toContain('href={`/api/legal-video-scripts/${selected.id}/production-brief`}');
    expect(source).toContain('download={`legal-video-${selected.id}-r${selected.revision}.txt`}');
  });
});
