const TEXT_NODE = 3;
const BLOCK_TAGS = new Set(["DIV", "P", "LI"]);

export function serializeEditableText(root, onElementRange) {
  let text = "";

  const appendBreak = () => {
    if (text && !text.endsWith("\n")) text += "\n";
  };

  const walk = (node, isLast) => {
    if (node.nodeType === TEXT_NODE) {
      text += String(node.nodeValue || "").replace(/\u00a0/gu, " ");
      return;
    }

    const tagName = String(node.tagName || "").toUpperCase();
    if (!tagName) return;
    if (tagName === "BR") {
      text += "\n";
      return;
    }

    const block = BLOCK_TAGS.has(tagName);
    if (block) appendBreak();

    const start = text.length;
    const children = Array.from(node.childNodes || []);
    children.forEach((child, index) => walk(child, index === children.length - 1));
    const end = text.length;
    if (end > start) onElementRange?.(node, start, end);

    if (block && !isLast) appendBreak();
  };

  const children = Array.from(root.childNodes || []);
  children.forEach((child, index) => walk(child, index === children.length - 1));
  return text.replace(/\n+$/u, "");
}
