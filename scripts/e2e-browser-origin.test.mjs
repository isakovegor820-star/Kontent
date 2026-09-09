import { expect, it } from "vitest";
import { parseOwnedE2eBrowserOrigin, resolveOwnedE2eBrowserOrigins } from "./e2e-browser-origin.mjs";

it.each(["http://127.0.0.1:12345", "https://localhost:12345", "https://[::1]:12345", "https://aurora-e2e.invalid:12345"])("accepts an exact owned browser origin: %s", value => {
  expect(parseOwnedE2eBrowserOrigin(value).origin).toBe(value);
});

it.each(["https://provider.invalid", "file:///tmp/fixture", "https://user:canary@localhost:12345", "ftp://127.0.0.1", "http://127.0.0.1:12345/path"])("rejects an unsafe browser origin: %s", value => {
  expect(() => parseOwnedE2eBrowserOrigin(value)).toThrow("explicit loopback");
});

it("maps only the reserved host with the exact owned protocol and port", () => {
  expect(resolveOwnedE2eBrowserOrigins("https://127.0.0.1:12345", "https://aurora-e2e.invalid:12345")).toMatchObject({
    base: { origin: "https://127.0.0.1:12345" }, browser: { origin: "https://aurora-e2e.invalid:12345" },
  });
  for (const value of ["http://aurora-e2e.invalid:12345", "https://aurora-e2e.invalid:12346", "https://other.invalid:12345"]) {
    expect(() => resolveOwnedE2eBrowserOrigins("https://127.0.0.1:12345", value)).toThrow();
  }
});
