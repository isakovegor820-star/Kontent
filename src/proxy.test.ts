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

  it("hides experimental routes by default without weakening the CSP", () => {
    const previous = process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
    delete process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
    try {
      const response = proxy(new NextRequest("https://aurora.example/app/autopilot/month"));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe("https://aurora.example/app/calendar");
      expect(response.headers.get("content-security-policy")).toContain("script-src");
    } finally {
      if (previous == null) delete process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
      else process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES = previous;
    }
  });

  it("allows a deliberate experimental preview", () => {
    const previous = process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
    process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES = "1";
    try {
      const response = proxy(new NextRequest("https://aurora.example/app/autopilot"));
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    } finally {
      if (previous == null) delete process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
      else process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES = previous;
    }
  });

  it("returns a non-discoverable response for experimental APIs by default", async () => {
    const previous = process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
    delete process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
    try {
      const response = proxy(new NextRequest("https://aurora.example/api/autopilot/generate"));
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ ok: false, error: "not_found" });
    } finally {
      if (previous == null) delete process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
      else process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES = previous;
    }
  });
});
