const OPEN_THINK_TAG = "<think>";
const CLOSE_THINK_TAG = "</think>";

function trailingTagPrefixLength(value, tag) {
  const lower = value.toLowerCase();
  const maximum = Math.min(lower.length, tag.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (lower.endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Removes provider reasoning blocks without ever exposing an unfinished `<think>` block.
 * The filter deliberately buffers leading whitespace and split tag prefixes so an
 * orchestrator does not mistake them for the first user-visible token.
 */
export function createVisibleAiContentFilter() {
  let buffer = "";
  let insideThink = false;
  let visibleContent = false;
  let pendingLeadingWhitespace = "";
  let reasoningDetected = false;

  const emitVisible = (value) => {
    if (!value) return "";
    if (visibleContent) return value;
    pendingLeadingWhitespace += value;
    if (!pendingLeadingWhitespace.trim()) return "";
    visibleContent = true;
    const output = pendingLeadingWhitespace;
    pendingLeadingWhitespace = "";
    return output;
  };

  const push = (chunk) => {
    buffer += String(chunk ?? "");
    let output = "";

    while (buffer) {
      if (insideThink) {
        const closeIndex = buffer.toLowerCase().indexOf(CLOSE_THINK_TAG);
        if (closeIndex >= 0) {
          reasoningDetected = true;
          buffer = buffer.slice(closeIndex + CLOSE_THINK_TAG.length);
          insideThink = false;
          continue;
        }
        const keep = trailingTagPrefixLength(buffer, CLOSE_THINK_TAG);
        if (buffer.length > keep) reasoningDetected = true;
        buffer = keep ? buffer.slice(-keep) : "";
        break;
      }

      const openIndex = buffer.toLowerCase().indexOf(OPEN_THINK_TAG);
      if (openIndex >= 0) {
        output += emitVisible(buffer.slice(0, openIndex));
        reasoningDetected = true;
        buffer = buffer.slice(openIndex + OPEN_THINK_TAG.length);
        insideThink = true;
        if (!visibleContent) pendingLeadingWhitespace = "";
        continue;
      }

      const keep = trailingTagPrefixLength(buffer, OPEN_THINK_TAG);
      output += emitVisible(buffer.slice(0, buffer.length - keep));
      buffer = keep ? buffer.slice(-keep) : "";
      break;
    }

    return output;
  };

  const finish = () => {
    if (insideThink) {
      if (buffer) reasoningDetected = true;
      buffer = "";
      pendingLeadingWhitespace = "";
      return "";
    }
    const output = emitVisible(buffer);
    buffer = "";
    pendingLeadingWhitespace = "";
    return output;
  };

  return {
    push,
    finish,
    get hasVisibleContent() {
      return visibleContent;
    },
    get reasoningDetected() {
      return reasoningDetected;
    },
  };
}

export function stripAiReasoning(value) {
  const filter = createVisibleAiContentFilter();
  const text = filter.push(value) + filter.finish();
  return {
    text,
    reasoningDetected: filter.reasoningDetected,
  };
}
