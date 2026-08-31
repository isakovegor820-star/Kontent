import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("Studio responsive recovery controls", () => {
  it("allows a long suggested engine label to wrap on narrow screens", () => {
    expect(source).toContain("flex flex-col items-stretch gap-3");
    expect(source).toContain("w-full whitespace-normal text-pretty sm:w-auto sm:shrink-0");
  });

  it("uses one native history entry for the one-shot reference flow", () => {
    expect(source).toContain('const composerHref = `/app/composer?draft=${result.draft.id}&from=studio${suggestMedia}`');
    expect(source).toContain('window.history.replaceState(window.history.state, "", `/app/studio?draft=${generation.referenceDraftId}`)');
    expect(source).toContain("window.location.assign(composerHref)");
    expect(source.indexOf("window.location.assign(composerHref)")).toBeLessThan(
      source.indexOf("router.push(composerHref)"),
    );
  });
});
