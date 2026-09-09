import { mkdir, writeFile } from "node:fs/promises";
import { parse } from "parse5";
import { parseTelegramPublicPage } from "../worker/telegram-public-page.mjs";

// Read-only cross-check against primary public markup using an independent DOM parser.
const url = process.argv[2] || "https://t.me/s/ifax_go";
if (!/^https:\/\/t\.me\/s\/[a-z0-9_]+(?:\?before=\d+)?$/iu.test(url)) throw new Error("Public Telegram preview URL required");
const response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { "user-agent": "Mozilla/5.0" } });
if (!response.ok) throw new Error(`Telegram returned ${response.status}`);
const html = await response.text();
const attr = (node, name) => node.attrs?.find(attribute => attribute.name === name)?.value;
function all(node, predicate) {
  return [...(predicate(node) ? [node] : []), ...(node.childNodes || []).flatMap(child => all(child, predicate))];
}
const text = node => node.nodeName === "#text" ? node.value : (node.childNodes || []).map(text).join("");
const blocks = all(parse(html), node => Boolean(attr(node, "data-post")));
const parsed = new Map(parseTelegramPublicPage(html).map(post => [post.msgId, post]));
const comparisons = blocks.map(block => {
  const post = attr(block, "data-post"), id = Number(post.split("/").at(-1));
  const counter = all(block, node => (attr(node, "class") || "").split(" ").includes("tgme_widget_message_views"))[0];
  const rawViews = counter ? text(counter).trim() : null;
  const match = rawViews?.replaceAll(",", ".").match(/^([\d.]+)\s*([KM])?$/iu);
  const expectedViews = match ? Number(match[1]) * ({ K: 1000, M: 1000000 }[match[2]?.toUpperCase()] || 1) : null;
  const time = all(block, node => node.tagName === "time")[0];
  const expectedDate = time ? attr(time, "datetime") : null;
  const actual = parsed.get(id);
  return { url: `https://t.me/${post}`, rawViews, expectedViews, parsedViews: actual?.views ?? null,
    postedAt: expectedDate, parsedDate: actual?.postedAt ?? null,
    matches: Boolean(actual) && actual.views === expectedViews && actual.postedAt === expectedDate };
});
const report = { source: url, fetchedAt: new Date().toISOString(), httpStatus: response.status,
  note: "Telegram public counters may be rounded; this checks extraction, not historical production database values.",
  posts: comparisons.length, matched: comparisons.filter(post => post.matches).length, comparisons };
const directory = new URL("../reports/trends-dashboard-2026-09-09/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL("source-audit.json", directory), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!comparisons.length || comparisons.some(post => !post.matches)) process.exitCode = 1;
