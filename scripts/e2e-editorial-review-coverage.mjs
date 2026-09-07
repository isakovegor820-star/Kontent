import assert from "node:assert/strict";

/** Verify rendered editorial text; document width alone misses overlap inside a fixed-width card. */
export async function assertEditorialSubmissionReflow(page, {
  label,
  widths = [320, 390, 640],
}) {
  assert(["Сохранить и отправить на согласование", "Сохранить и отправить повторно"].includes(label));
  assert(widths === null || (Array.isArray(widths) && widths.length > 0
    && widths.every((width) => Number.isInteger(width) && width >= 240)));
  const originalViewport = page.viewportSize();
  // null measures the existing native-zoom viewport without replacing it with CSS emulation.
  assert(originalViewport || widths === null, "Editorial reflow requires a restorable viewport");
  const evidence = [];
  let failure;
  try {
    for (const width of widths ?? [null]) {
      if (width !== null) await page.setViewportSize({ ...originalViewport, width });
      const button = page.getByRole("button", { name: label, exact: true });
      // Let viewport reflow and scroll anchoring settle before centering the measured target.
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await button.evaluate((element) => element.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" }));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      // Resize can trigger a later scroll-anchor adjustment. Require the same
      // stable/visible/receives-events checks as the ensuing real user click,
      // without dispatching it. A persistent overlay or disabled target fails.
      try { await button.click({ trial: true, timeout: 5_000 }); }
      catch (cause) { throw new Error("Editorial submission label is clipped or unreachable before measurement", { cause }); }
      const geometry = await button.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const parent = element.parentElement.getBoundingClientRect();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const textRects = [];
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(walker.currentNode);
          textRects.push(...Array.from(range.getClientRects(), (item) => ({ left: item.left, right: item.right, top: item.top, bottom: item.bottom })));
        }
        const heading = element.closest("section").querySelector("h2");
        const column = heading.parentElement;
        const columnRect = column.getBoundingClientRect();
        const badgeRect = column.nextElementSibling.getBoundingClientRect();
        const headingRange = document.createRange(); headingRange.selectNodeContents(heading);
        const headingRects = Array.from(headingRange.getClientRects(), (item) => ({ left: item.left, right: item.right, top: item.top, bottom: item.bottom }));
        return {
          label: element.textContent.trim(), viewport: innerWidth,
          document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
          left: rect.left, right: rect.right, height: rect.height, parentLeft: parent.left, parentRight: parent.right,
          whiteSpace: getComputedStyle(element.querySelector("span") || element).whiteSpace,
          textRects, textInside: textRects.length > 0 && textRects.every((item) => item.left >= rect.left && item.right <= rect.right && item.top >= rect.top && item.bottom <= rect.bottom),
          hit: element.contains(document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)),
          heading: {
            text: heading.textContent.trim(), flexBasis: getComputedStyle(column).flexBasis,
            columnLeft: columnRect.left, columnRight: columnRect.right,
            badge: { left: badgeRect.left, right: badgeRect.right, top: badgeRect.top, bottom: badgeRect.bottom },
            textRects: headingRects,
            insideColumn: headingRects.length > 0 && headingRects.every((item) => item.left >= columnRect.left && item.right <= columnRect.right),
            overlapsBadge: headingRects.some((item) => item.left < badgeRect.right && item.right > badgeRect.left && item.top < badgeRect.bottom && item.bottom > badgeRect.top),
          },
        };
      });
      evidence.push(geometry);
      assert.equal(geometry.label, label);
      assert.equal(geometry.heading.text, "Согласование материала");
      assert(geometry.heading.insideColumn && !geometry.heading.overlapsBadge,
        `Editorial heading overlaps its status or exceeds its column: ${JSON.stringify(geometry.heading)}`);
      assert(geometry.document <= geometry.viewport && geometry.body <= geometry.viewport
        && geometry.left >= geometry.parentLeft && geometry.right <= geometry.parentRight
        && geometry.left >= 0 && geometry.right <= geometry.viewport
        && geometry.height >= 44 && geometry.textInside && geometry.hit,
      `Editorial submission label is clipped or unreachable: ${JSON.stringify(geometry)}`);
    }
  } catch (error) { failure = error; }
  if (originalViewport && widths !== null) {
    try { await page.setViewportSize(originalViewport); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "Editorial reflow and viewport restore failed") : error; }
  }
  if (failure) throw failure;
  return evidence;
}
