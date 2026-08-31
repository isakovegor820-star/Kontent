import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("trends accessibility recovery", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/app/app/trends/page.tsx"), "utf8");

  it("gives image-only source links an accessible name", () => {
    expect(source).toContain('aria-label="Открыть изображение публикации в источнике"');
  });

  it("returns focus to the internet query after validation failures", () => {
    expect(source).toMatch(/query\.length < 2[\s\S]*?internetSearchInputRef\.current\?\.focus\(\)/);
    expect(source).toMatch(/destinationChannelId <= 0[\s\S]*?internetSearchInputRef\.current\?\.focus\(\)/);
  });

  it("aborts pending loads before Firefox tears down a navigating page", () => {
    expect(source).toContain('window.addEventListener("beforeunload", cancelPendingLoad)');
    expect(source).toContain('window.removeEventListener("beforeunload", cancelPendingLoad)');
    expect(source).toContain('window.addEventListener("pagehide", cancelPendingLoad)');
  });
});
