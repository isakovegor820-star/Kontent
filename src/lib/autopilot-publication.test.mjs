import { describe, expect, it } from "vitest";

import { sanitizeAutopilotPublicText } from "./autopilot-publication.mjs";

describe("Autopilot public text", () => {
  it("keeps research attribution out of a reader-facing post", () => {
    expect(sanitizeAutopilotPublicText(
      "Полезный разбор.\n\nИсточник: Право.ru\nhttps://pravo.ru/news/1",
    )).toBe("Полезный разбор.");
    expect(sanitizeAutopilotPublicText(
      "Полезный разбор.\n\nПервоисточник: https://example.com/story",
    )).toBe("Полезный разбор.");
  });

  it("normalizes trailing spaces and excessive blank lines", () => {
    expect(sanitizeAutopilotPublicText("Хук   \n\n\n\nСмысл  "))
      .toBe("Хук\n\nСмысл");
  });
});
