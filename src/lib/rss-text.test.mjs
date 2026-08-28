import { describe, expect, it } from "vitest";

import { decodeRssBytes, decodeRssResponse } from "./rss-text.mjs";

function windows1251(value) {
  const table = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя";
  const bytes = [];
  for (const character of value) {
    const index = table.indexOf(character);
    if (index >= 0) {
      const upper = index < 33;
      const alphabetIndex = upper ? index : index - 33;
      if (alphabetIndex === 6) bytes.push(upper ? 0xa8 : 0xb8);
      else bytes.push((upper ? 0xc0 : 0xe0) + alphabetIndex - (alphabetIndex > 6 ? 1 : 0));
    } else {
      bytes.push(character.charCodeAt(0));
    }
  }
  return Uint8Array.from(bytes);
}

describe("RSS response decoding", () => {
  it("decodes a Windows-1251 XML declaration before parsing", () => {
    const xml = '<?xml version="1.0" encoding="windows-1251"?><rss><channel><title>Гарант</title></channel></rss>';
    expect(decodeRssBytes(windows1251(xml))).toContain("<title>Гарант</title>");
  });

  it("uses the HTTP charset when it is present", () => {
    const xml = "<rss><channel><title>Новости</title></channel></rss>";
    expect(decodeRssBytes(windows1251(xml), { "content-type": "application/xml; charset=windows-1251" }))
      .toContain("Новости");
  });

  it("rejects unsupported and already-corrupted encodings", async () => {
    expect(() => decodeRssBytes(new TextEncoder().encode('<?xml version="1.0" encoding="koi8-r"?><rss/>')))
      .toThrow(expect.objectContaining({ code: "unsupported_encoding" }));
    await expect(decodeRssResponse({ text: async () => "<title>����</title>" }))
      .rejects.toMatchObject({ code: "invalid_encoding" });
  });
});
