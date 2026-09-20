import { parse } from "parse5";

/** Inspect parsed, executable HEAD markup; comments, examples and templates are not proof. */
export function hasTrackerSiteProof(html: string, input: {
  challenge: string;
  publicKey: string;
  appOrigin: string;
}): boolean {
  const document = parse(html);
  const root = document.childNodes.find((node) => "tagName" in node && node.tagName === "html");
  if (!root || !("childNodes" in root)) return false;
  const head = root.childNodes.find((node) => "tagName" in node && node.tagName === "head");
  if (!head || !("childNodes" in head)) return false;
  let expectedSource: string;
  try {
    const app = new URL(input.appOrigin);
    if (!["https:", "http:"].includes(app.protocol)) return false;
    expectedSource = `${app.origin}/api/tracking/client.js`;
  } catch {
    return false;
  }
  return head.childNodes.some((node) => {
    if (!("tagName" in node) || node.tagName !== "script") return false;
    const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
    const type = (attrs.get("type") ?? "").trim().toLowerCase();
    return attrs.get("src") === expectedSource
      && attrs.get("data-project-key") === input.publicKey
      && attrs.get("data-aurora-verification") === input.challenge
      && !attrs.has("nomodule")
      && ["", "text/javascript", "application/javascript"].includes(type);
  });
}
