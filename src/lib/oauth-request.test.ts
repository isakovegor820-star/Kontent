import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { callbackUrlFromReq } from "./oauth-request";

const previousAppUrl = process.env.APP_URL;

afterEach(() => {
  if (previousAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previousAppUrl;
});

describe("callbackUrlFromReq", () => {
  it("ignores forwarded host poisoning when APP_URL is configured", () => {
    process.env.APP_URL = "https://app.aurora.example/base/path";
    const request = new NextRequest("http://internal:3000/api/channels/oauth/start", {
      headers: {
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    });

    expect(callbackUrlFromReq(request, "youtube")).toBe(
      "https://app.aurora.example/api/channels/oauth/callback?network=youtube",
    );
  });

  it("uses the actual local request origin only when APP_URL is absent outside production", () => {
    delete process.env.APP_URL;
    const request = new NextRequest("http://localhost:3005/api/channels/oauth/start", {
      headers: { "x-forwarded-host": "attacker.example" },
    });

    expect(callbackUrlFromReq(request, "instagram")).toBe(
      "http://localhost:3005/api/channels/oauth/callback?network=instagram",
    );
  });
});
