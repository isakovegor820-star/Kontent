import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "./proxy";

function responsePolicy() {
  return proxy(new NextRequest("https://aurora.example/app"))
    .headers.get("content-security-policy") ?? "";
}

describe("request security proxy", () => {
  it("emits a fresh nonce-bound policy for every document request", () => {
    const first = responsePolicy();
    const second = responsePolicy();
    const firstNonce = first.match(/'nonce-([^']+)'/u)?.[1];
    const secondNonce = second.match(/'nonce-([^']+)'/u)?.[1];

    expect(firstNonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);
    expect(first).toMatch(/script-src[^;]*'strict-dynamic'/u);
    expect(first).not.toMatch(/script-src[^;]*'unsafe-inline'/u);
  });
});
