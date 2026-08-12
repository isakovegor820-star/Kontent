import { describe, expect, it } from "vitest";

import { readPublicationSettingsBody } from "./_shared";

function request(body: BodyInit, contentType = "application/json") {
  return new Request("http://localhost/api/publication-blocks", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

describe("publication settings body boundary", () => {
  it("accepts only explicitly allowed JSON keys", async () => {
    await expect(readPublicationSettingsBody(
      request(JSON.stringify({ name: "Подпись" })),
      ["name"],
    )).resolves.toEqual({ name: "Подпись" });
    await expect(readPublicationSettingsBody(
      request(JSON.stringify({ name: "Подпись", projectId: 999 })),
      ["name"],
    )).resolves.toBeNull();
  });

  it("rejects a wrong media type, invalid UTF-8 and the actual oversized stream", async () => {
    await expect(readPublicationSettingsBody(
      request("{}", "text/plain"),
      [],
    )).resolves.toBeNull();
    await expect(readPublicationSettingsBody(
      request(new Uint8Array([0xc3, 0x28])),
      [],
    )).resolves.toBeNull();
    await expect(readPublicationSettingsBody(
      request(JSON.stringify({ body: "x".repeat(17 * 1024) })),
      ["body"],
    )).resolves.toBeNull();
  });
});
