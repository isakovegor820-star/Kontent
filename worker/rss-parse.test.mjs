// Тесты парсера RSS/Atom (чистая функция из worker/lib.mjs).
import { describe, it, expect } from "vitest";
import { parseRss } from "./lib.mjs";

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>Test Blog</title>
  <link>https://example.com</link>
  <item>
    <title>First Post</title>
    <link>https://example.com/first</link>
    <description>Hello world description</description>
    <guid>https://example.com/first</guid>
    <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[Second Post with CDATA]]></title>
    <link>https://example.com/second</link>
    <description>Another description</description>
    <pubDate>Tue, 02 Jan 2024 08:30:00 GMT</pubDate>
  </item>
</channel>
</rss>`;

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Atom Entry One</title>
    <link href="https://example.com/atom/1"/>
    <id>urn:uuid:entry-1</id>
    <summary>Summary of entry one</summary>
    <published>2024-03-10T10:00:00Z</published>
  </entry>
  <entry>
    <title>Atom Entry Two</title>
    <link href="https://example.com/atom/2"/>
    <id>urn:uuid:entry-2</id>
    <content>Full content of entry two</content>
    <updated>2024-03-11T14:30:00Z</updated>
  </entry>
</feed>`;

describe("parseRss — RSS 2.0", () => {
  const items = parseRss(RSS_SAMPLE);

  it("находит все элементы", () => {
    expect(items.length).toBe(2);
  });

  it("разбирает title, link, summary, guid", () => {
    const [first] = items;
    expect(first.title).toBe("First Post");
    expect(first.link).toBe("https://example.com/first");
    expect(first.summary).toBe("Hello world description");
    expect(first.guid).toBe("https://example.com/first");
  });

  it("разбирает CDATA в title", () => {
    expect(items[1].title).toBe("Second Post with CDATA");
  });

  it("парсит дату в ISO", () => {
    expect(items[0].publishedAt).toBe("2024-01-01T12:00:00.000Z");
  });

  it("guid фолбэчит на link, если нет <guid>", () => {
    // Второй элемент не имеет <guid>
    expect(items[1].guid).toBe("https://example.com/second");
  });
});

describe("parseRss — Atom", () => {
  const items = parseRss(ATOM_SAMPLE);

  it("находит все entry", () => {
    expect(items.length).toBe(2);
  });

  it("разбирает link из href атрибута", () => {
    expect(items[0].link).toBe("https://example.com/atom/1");
  });

  it("берёт id как guid", () => {
    expect(items[0].guid).toBe("urn:uuid:entry-1");
  });

  it("использует content если нет summary", () => {
    expect(items[1].summary).toBe("Full content of entry two");
  });

  it("published фолбэчит на updated", () => {
    expect(items[1].publishedAt).toBe("2024-03-11T14:30:00.000Z");
  });
});

describe("parseRss — edge cases", () => {
  it("пустой XML → пустой массив", () => {
    expect(parseRss("<rss><channel></channel></rss>")).toEqual([]);
    expect(parseRss("")).toEqual([]);
  });

  it("элемент без title и summary пропускается", () => {
    const xml = `<rss><channel><item><link>https://x.com</link></item></channel></rss>`;
    expect(parseRss(xml)).toEqual([]);
  });

  it("обрезает длинные поля", () => {
    const longTitle = "A".repeat(500);
    const xml = `<rss><channel><item><title>${longTitle}</title><description>ok</description></item></channel></rss>`;
    const [item] = parseRss(xml);
    expect(item.title.length).toBeLessThanOrEqual(300);
  });
});
