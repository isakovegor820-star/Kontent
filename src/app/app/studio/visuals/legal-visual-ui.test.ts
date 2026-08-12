import { describe, expect, it } from "vitest";

import {
  legalVisualFontFamily,
  mediaAssetToVisualReference,
  nextLegalVisualStudioTab,
  toggleAllowedVisualFont,
} from "./legal-visual-ui";

describe("legal visual studio client helpers", () => {
  it("turns a project media asset into the exact server-side logo reference", () => {
    expect(mediaAssetToVisualReference({
      id: 42,
      fileName: "logo.png",
      mimeType: "image/png",
      sha256: "A".repeat(64),
      width: 800,
      height: 320,
      metadata: { alt: "  Логотип бюро  " },
    }, "Логотип проекта")).toEqual({
      assetId: "42",
      alt: "Логотип бюро",
      mimeType: "image/png",
      width: 800,
      height: 320,
      sha256: "a".repeat(64),
    });
  });

  it("uses safe dimensions and a visible fallback description for older assets", () => {
    expect(mediaAssetToVisualReference({
      id: 7,
      fileName: "old.webp",
      mimeType: "image/webp",
      sha256: "b".repeat(64),
      width: null,
      height: null,
      metadata: {},
    }, "Логотип проекта")).toMatchObject({
      alt: "Логотип проекта",
      width: 1,
      height: 1,
    });
  });

  it("never leaves a brand without an allowed font and moves the active font safely", () => {
    expect(toggleAllowedVisualFont({
      allowedFonts: ["aurora-sans"],
      activeFont: "aurora-sans",
      font: "aurora-sans",
      enabled: false,
    })).toEqual({ allowedFonts: ["aurora-sans"], activeFont: "aurora-sans" });

    expect(toggleAllowedVisualFont({
      allowedFonts: ["aurora-sans", "legal-serif"],
      activeFont: "aurora-sans",
      font: "aurora-sans",
      enabled: false,
    })).toEqual({ allowedFonts: ["legal-serif"], activeFont: "legal-serif" });

    expect(toggleAllowedVisualFont({
      allowedFonts: ["legal-serif"],
      activeFont: "legal-serif",
      font: "technical-mono",
      enabled: true,
    })).toEqual({
      allowedFonts: ["legal-serif", "technical-mono"],
      activeFont: "legal-serif",
    });
  });

  it("implements the APG horizontal-tab loop with Home and End", () => {
    expect(nextLegalVisualStudioTab("carousel", "ArrowRight")).toBe("video");
    expect(nextLegalVisualStudioTab("video", "ArrowRight")).toBe("carousel");
    expect(nextLegalVisualStudioTab("carousel", "ArrowLeft")).toBe("video");
    expect(nextLegalVisualStudioTab("video", "ArrowLeft")).toBe("carousel");
    expect(nextLegalVisualStudioTab("video", "Home")).toBe("carousel");
    expect(nextLegalVisualStudioTab("carousel", "End")).toBe("video");
    expect(nextLegalVisualStudioTab("carousel", "Tab")).toBeNull();
  });

  it("uses the same three font stacks as the deterministic renderer", () => {
    expect(legalVisualFontFamily("aurora-sans")).toContain("Arial");
    expect(legalVisualFontFamily("legal-serif")).toContain("Georgia");
    expect(legalVisualFontFamily("technical-mono")).toContain("SFMono-Regular");
  });
});
