import { describe, expect, it } from "vitest";

import { DEFAULT_POST_SETTINGS } from "./post-settings";
import {
  legalOpportunityPostSettings,
  legalOpportunitySourceClientKey,
  legalOpportunityVariantFromClientKey,
  parseLegalOpportunityPostVariant,
} from "./legal-opportunity-post";

describe("legal opportunity post contract", () => {
  it("keeps channel and variant in the idempotent source key", () => {
    const key = legalOpportunitySourceClientKey(88, 11, "expert");
    expect(key).toBe("rss_item_source:88:channel:11:variant:expert");
    expect(legalOpportunityVariantFromClientKey(key)).toBe("expert");
    expect(legalOpportunityVariantFromClientKey("rss_item_source:88")).toBe("standard");
  });

  it("falls back to the standard variant for untrusted input", () => {
    expect(parseLegalOpportunityPostVariant("unknown")).toBe("standard");
    expect(parseLegalOpportunityPostVariant("selling")).toBe("selling");
  });

  it("creates platform-specific editable post settings", () => {
    const instagram = legalOpportunityPostSettings(DEFAULT_POST_SETTINGS, "short", "instagram");
    expect(instagram).toMatchObject({
      target: "instagram_post",
      length: "short",
      cta: "save",
      hashtags: "custom",
      hashtagCount: 5,
      requireNewAngle: true,
      factStrictness: "verified_inference",
    });

    const selling = legalOpportunityPostSettings(DEFAULT_POST_SETTINGS, "selling", "vk");
    expect(selling).toMatchObject({ target: "vk_community", cta: "buy", length: "medium" });
  });
});
