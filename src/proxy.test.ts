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

  it("keeps every signed-in product section available by default", () => {
    const previous = process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
    delete process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
    try {
      const response = proxy(new NextRequest("https://aurora.example/app/autopilot/month"));
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
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
      const response = proxy(new NextRequest("https://aurora.example/variants/1"));
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
    } finally {
      if (previous == null) delete process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
      else process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES = previous;
    }
  });

  it("allows the stable bot connection page without opening the rest of the bot prefix", () => {
    const previous = process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
    delete process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
    try {
      const connect = proxy(new NextRequest("https://aurora.example/bot/connect"));
      expect(connect.status).toBe(200);
      expect(connect.headers.get("location")).toBeNull();

      const bot = proxy(new NextRequest("https://aurora.example/bot"));
      expect(bot.status).toBe(307);
      expect(bot.headers.get("location")).toBe("https://aurora.example/");
    } finally {
      if (previous == null) delete process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
      else process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES = previous;
    }
  });

  it("keeps APIs for released product sections available by default", () => {
    const previous = process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
    delete process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
    try {
      const response = proxy(new NextRequest("https://aurora.example/api/autopilot/generate"));
      expect(response.status).toBe(200);
    } finally {
      if (previous == null) delete process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES;
      else process.env.NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES = previous;
    }
  });
});
