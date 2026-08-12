import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("favicon compatibility route", () => {
  it("redirects the conventional browser request to the Aurora icon", () => {
    const response = GET(new Request("https://aurora.test/favicon.ico"));

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://aurora.test/icon.svg");
  });
});
