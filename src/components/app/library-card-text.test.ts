import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  LibraryCardText,
  handleLibraryCardTextToggle,
  libraryCardContentId,
  toggleExpandedCardId,
} from "./library-card-text";

describe("LibraryCardText", () => {
  it("renders a real controlled expansion button for closed and open text", () => {
    const contentId = libraryCardContentId("hit", 41);
    const closed = renderToStaticMarkup(createElement(LibraryCardText, {
      contentId,
      text: "Полный текст референса",
      expanded: false,
      onToggle: vi.fn(),
    }));
    const opened = renderToStaticMarkup(createElement(LibraryCardText, {
      contentId,
      text: "Полный текст референса",
      expanded: true,
      onToggle: vi.fn(),
    }));

    expect(closed).toContain("line-clamp-4");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain(`aria-controls="${contentId}"`);
    expect(closed).toContain("Развернуть");
    expect(opened).not.toContain("line-clamp-4");
    expect(opened).toContain('aria-expanded="true"');
    expect(opened).toContain("Свернуть");
    expect(opened).toContain("Полный текст референса");
  });

  it("toggles card ids independently without mutating the previous set", () => {
    const empty = new Set<string>();
    const first = toggleExpandedCardId(empty, "hit:41");
    const both = toggleExpandedCardId(first, "post:9");
    const secondOnly = toggleExpandedCardId(both, "hit:41");

    expect(empty.size).toBe(0);
    expect(first).toEqual(new Set(["hit:41"]));
    expect(both).toEqual(new Set(["hit:41", "post:9"]));
    expect(secondOnly).toEqual(new Set(["post:9"]));
  });

  it("stops the card click before changing expansion state", () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const onToggle = vi.fn();

    handleLibraryCardTextToggle({ preventDefault, stopPropagation }, onToggle);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(stopPropagation.mock.invocationCallOrder[0]).toBeLessThan(
      onToggle.mock.invocationCallOrder[0],
    );
  });
});
