import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("onboarding competitor step", () => {
  it("submits the inline add form from the visible button", () => {
    expect(source).toMatch(
      /<Button\s+type="submit"[\s\S]{0,320}>[\s\S]{0,120}Добавить канал/,
    );
  });

  it("adds the competitor to the channel selected during onboarding", () => {
    expect(source).toContain('body: JSON.stringify({ url: link, network: "tg", channelId })');
    expect(source).toContain("channelId={effectiveChannelId}");
  });

  it("explains why a private invitation cannot be indexed", () => {
    expect(source).toContain("Это ссылка-приглашение в закрытый канал");
    expect(source).toContain("Канал должен открываться без вступления");
  });
});
