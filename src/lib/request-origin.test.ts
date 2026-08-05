import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { hasTrustedMutationOrigin } from "./request-origin";

function request(headers: Record<string, string>) {
  return new NextRequest("http://internal:3000/api/drafts", {
    method: "POST",
    headers: { host: "internal:3000", ...headers },
  });
}

describe("hasTrustedMutationOrigin", () => {
  it("accepts the public forwarded origin", () => {
    expect(hasTrustedMutationOrigin(request({
      origin: "https://aurora.example",
      "x-forwarded-host": "aurora.example",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
    }))).toBe(true);
  });

  it("rejects cross-site and mismatched browser mutations", () => {
    expect(hasTrustedMutationOrigin(request({
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    }))).toBe(false);
    expect(hasTrustedMutationOrigin(request({
      origin: "https://evil.example",
      "sec-fetch-site": "same-site",
    }))).toBe(false);
  });

  it("allows authenticated server clients without browser metadata", () => {
    expect(hasTrustedMutationOrigin(request({}))).toBe(true);
  });
});
