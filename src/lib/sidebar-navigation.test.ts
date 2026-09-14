import { describe, expect, it } from "vitest";
import { activeChildHref, childHref, NAV_CHILDREN } from "./sidebar-navigation";

describe("sidebar route identity", () => {
  it.each([
    ["studio", "/app/studio", "", "/app/studio?mode=chat"],
    ["studio", "/app/studio", "mode=media", "/app/studio?mode=media"],
    ["studio", "/app/studio/questions", "", "/app/studio/questions"],
    ["library", "/app/library", "channel=42", "/app/library?tab=hits"],
    ["library", "/app/library", "tab=posts&channel=42", "/app/library?tab=posts"],
    ["rss", "/app/rss", "channel=42", "/app/rss"],
    ["rss", "/app/rss", "view=saved&channel=42", "/app/rss?view=saved"],
    ["rss", "/app/rss", "view=hidden", "/app/rss?view=hidden"],
    ["settings", "/app/settings", "", "/app/settings?section=profile"],
    ["settings", "/app/settings", "section=channels", null],
    ["recon", "/app/trends", "", "/app/trends"],
    ["autopilot", "/app/autopilot/month", "", "/app/autopilot/month"],
  ] as const)("matches %s %s?%s", (section, path, query, expected) => {
    expect(activeChildHref(section, path, query)).toBe(expected);
  });
  it("retains channel context without forwarding another section's filters", () => {
    expect(childHref(NAV_CHILDREN.rss![1], new URLSearchParams("channel=42&tab=posts&guide=rss")))
      .toBe("/app/rss?view=saved&channel=42");
    expect(childHref(NAV_CHILDREN.studio![0], new URLSearchParams("channel=42"))).toBe("/app/studio?mode=chat");
  });
});
