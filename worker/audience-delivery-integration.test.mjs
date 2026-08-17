import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");
const contractSource = await readFile(
  new URL("../src/lib/audience-delivery-contract.mjs", import.meta.url),
  "utf8",
);

function functionSource(name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`async function ${nextName}`, start + 1);
  if (start < 0 || end < 0) throw new Error(`worker function not found: ${name}`);
  return source.slice(start, end);
}

describe("Telegram audience delivery integration", () => {
  it("carries inquiry versions in every mutating callback", () => {
    expect(source).toContain("client:send:${item.id}:${token}");
    expect(source).toContain("client:draft:${item.id}:${token}");
    expect(source).toContain("client:dismiss:${item.id}:${token}");
    expect(source).toContain("client:confirm:${item.id}:${token}");
    expect(source).toContain("client:retry:${item.id}:${token}");
  });

  it("uses CAS and increments versions for bot mutations", () => {
    for (const [name, next] of [
      ["botPrepareClientReply", "botSendClientReply"],
      ["botSendClientReply", "botResolveClientDelivery"],
      ["botResolveClientDelivery", "botDismissClientInquiry"],
      ["botDismissClientInquiry", "botTranscribeVoice"],
    ]) {
      const body = functionSource(name, next);
      expect(body).toContain("version = version + 1");
      expect(body).toMatch(/inquiry\.version = \$\d/u);
    }
  });

  it("never turns a network-ambiguous send into an ordinary retry", () => {
    const body = functionSource("botSendClientReply", "botResolveClientDelivery");
    expect(source).toContain('from "./src/lib/audience-delivery-contract.mjs"');
    expect(body).toContain("classifyAudienceTelegramResponse(sent)");
    expect(body).toContain("botFailClientDelivery");
    expect(body).toContain("AUDIENCE_DELIVERY_ERROR_CODES.unknown");
    expect(body).toContain('return { status: "unknown" }');
    expect(body).not.toContain(".catch(() => null)");
  });

  it("records manual resolution and provider failures as durable audit events", () => {
    expect(source).toContain("AUDIENCE_FAIL_DELIVERY_SQL");
    expect(contractSource).toContain("audience.reply.delivery_failed");
    expect(source).toContain("audience.reply.delivery_resolved");
    expect(source).toContain("[audience_delivery_event]");
  });
});
