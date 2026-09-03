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

describe("hosted section proxy", () => {
  const withSitesDomain = (fn: () => void) => {
    const previous = process.env.AURORA_SITES_DOMAIN;
    process.env.AURORA_SITES_DOMAIN = "sites.aurora.example";
    try {
      fn();
    } finally {
      if (previous == null) delete process.env.AURORA_SITES_DOMAIN;
      else process.env.AURORA_SITES_DOMAIN = previous;
    }
  };

  it("rewrites a client subdomain to the internal hosted route and keeps the CSP", () => {
    withSitesDomain(() => {
      const response = proxy(new NextRequest("https://clinic.sites.aurora.example/skolko-stoit", { headers: { host: "clinic.sites.aurora.example" } }));
      expect(response.headers.get("x-middleware-rewrite")).toContain("/hosted/clinic/skolko-stoit");
      expect(response.headers.get("content-security-policy")).toContain("script-src");
      const root = proxy(new NextRequest("https://clinic.sites.aurora.example/", { headers: { host: "clinic.sites.aurora.example" } }));
      expect(root.headers.get("x-middleware-rewrite")).toMatch(/\/hosted\/clinic$/u);
    });
  });

  it("never serves the product UI or API from a hosted host", () => {
    withSitesDomain(() => {
      for (const path of ["/app/today", "/api/sites", "/hosted/clinic"]) {
        const response = proxy(new NextRequest(`https://clinic.sites.aurora.example${path}`, { headers: { host: "clinic.sites.aurora.example" } }));
        expect(response.status).toBe(404);
        expect(response.headers.get("x-middleware-rewrite")).toBeNull();
      }
    });
  });

  it("leaves the product host untouched", () => {
    withSitesDomain(() => {
      const response = proxy(new NextRequest("https://aurora.example/app/sites", { headers: { host: "aurora.example" } }));
      expect(response.headers.get("x-middleware-rewrite")).toBeNull();
      expect(response.status).toBe(200);
    });
  });
});
