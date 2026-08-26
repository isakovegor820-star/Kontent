import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("Studio responsive recovery controls", () => {
  it("allows a long suggested engine label to wrap on narrow screens", () => {
    expect(source).toContain("flex flex-col items-stretch gap-3");
    expect(source).toContain("w-full whitespace-normal text-pretty sm:w-auto sm:shrink-0");
  });
});
