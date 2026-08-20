import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("favicon compatibility route", () => {
  it("redirects the conventional browser request to the Aurora icon without trusting its origin", () => {
    const response = GET(new Request("https://aurora.test/favicon.ico"));

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/icon.svg");
  });

  it("does not reflect a spoofed host or protocol into the redirect", () => {
    const response = GET(new Request("https://localhost:43190/favicon.ico", {
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    }));

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/icon.svg");
  });
});
