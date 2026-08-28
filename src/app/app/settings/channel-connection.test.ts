import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("settings Telegram channel connection", () => {
  it("starts the native Telegram journey instead of reopening completed onboarding", () => {
    const channelsSection = source.slice(
      source.indexOf("function ChannelsSection"),
      source.indexOf("function vkConnectError"),
    );
    expect(channelsSection).toContain("requestTelegramChannelConnection()");
    expect(channelsSection).toContain("Выбрать канал в Telegram");
    expect(channelsSection).not.toContain('router.push("/app/onboarding")');
  });

  it("keeps Aurora open and polls for Telegram confirmation", () => {
    expect(source).toContain('window.open("about:blank", "aurora-telegram-channel")');
    expect(source).toContain('window.setInterval(() => void checkTelegramConnection(), 1_000)');
    expect(source).toContain("Канал «${label}» подключён и готов к публикациям.");
  });
});
