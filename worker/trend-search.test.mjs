import { describe, expect, it } from "vitest";
import { matureTrendBaseline, matureTrendRatio, trendHistoryBoundary } from "./trend-search.mjs";
import { parseTelegramPublicPage } from "./telegram-public-page.mjs";
const now = Date.parse("2026-09-09T12:00:00Z");
const post = (views, ageHours) => ({ views, postedAt: new Date(now - ageHours * 3600000).toISOString() });
describe("measured trend statistics", () => {
  it("uses five mature measurements, excluding missing counters, fresh posts and old history", () => {
    const baseline = matureTrendBaseline([post(100, 60), post(100, 70), post(100, 80), post(100, 90), post(100, 100), post(null, 70), post(2, 1), post(9000, 2400)], now);
    expect(baseline).toEqual({ medianViews: 100, baselinePosts: 5 });
    expect(matureTrendRatio(post(420, 72), baseline, now)).toBe(4.2);
    expect(matureTrendRatio(post(420, 4), baseline, now)).toBeNull();
    expect(matureTrendRatio(post(null, 72), baseline, now)).toBeNull();
  });
  it("does not turn a threshold or an insufficient sample into a measured ratio", () => {
    expect(matureTrendRatio(post(500, 72), { medianViews: 100, baselinePosts: 4 }, now)).toBeNull();
    expect(matureTrendRatio(post(500, 72), { medianViews: 0, baselinePosts: 5 }, now)).toBeNull();
    expect(matureTrendBaseline([post(100, 72)], now).medianViews).toBeNull();
  });
  it("preserves absent dates and counters while parsing real Telegram markup", () => {
    const html = '<div data-post="example/42"><div class="tgme_widget_message_text">Тема<br>поста</div></div>'
      + '<div data-post="example/43"><time datetime="2026-09-09T10:00:00Z"></time><span class="tgme_widget_message_views">1.2K</span></div>';
    const parsed = parseTelegramPublicPage(html);
    expect(parsed[0]).toMatchObject({ msgId: 42, views: null, reactions: null, postedAt: null, text: "Тема\nпоста" });
    expect(parsed[1]).toMatchObject({ msgId: 43, views: 1200, postedAt: "2026-09-09T10:00:00Z" });
  });
  it("only stops paging on an observed date boundary", () => {
    expect(trendHistoryBoundary([{ postedAt: null }], now)).toBe(false);
    expect(trendHistoryBoundary([post(100, 72)], now - 24 * 3600000)).toBe(true);
  });
});
