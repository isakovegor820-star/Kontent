import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("composer without the duplicate publication preview", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/app/app/composer/page.tsx"),
    "utf8",
  );

  it("keeps the editor as the only content pane", () => {
    expect(source).not.toContain("Как это увидят");
    expect(source).not.toContain('aria-label="Редактор или предпросмотр"');
    expect(source).not.toContain("TelegramPreview");
    expect(source).not.toContain("VkPreview");
    expect(source).toContain('className="mx-auto w-full max-w-5xl min-w-0 space-y-6 p-5 sm:p-6"');
  });

  it("does not promise the removed preview in surrounding copy", () => {
    expect(source).not.toContain("Предпросмотр покажет");
    expect(source).not.toContain("Границы показаны в предпросмотре");
    expect(source).toContain("Создавай, оформляй и добавляй публикации в календарь.");
  });
});
