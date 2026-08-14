import { describe, expect, it, vi } from "vitest";

import {
  emitLegalOpportunityUnreadCount,
  LEGAL_OPPORTUNITY_UNREAD_EVENT,
  legalOpportunityVisualState,
  safeLegalOpportunityUnreadCount,
  unreadLegalOpportunityCount,
  type LegalOpportunityUnreadItem,
} from "./legal-opportunity-unread";

function item(overrides: Partial<LegalOpportunityUnreadItem> = {}): LegalOpportunityUnreadItem {
  return {
    id: 1,
    title: "Новые налоговые правила вступают в силу",
    summary: "Компаниям нужно проверить срок подачи декларации.",
    feed_title: "ГАРАНТ.РУ",
    read_at: null,
    opportunity_state: null,
    post_id: null,
    status: "new",
    skip_reason: null,
    ...overrides,
  };
}

describe("legal opportunity unread count", () => {
  it("counts new relevant items and ignores read, used, hidden, and posted items", () => {
    expect(unreadLegalOpportunityCount([
      item({ id: 1 }),
      item({ id: 2, title: "Минфин разъяснил порядок уплаты НДС", read_at: "2026-08-14T10:00:00.000Z" }),
      item({ id: 3, title: "Суд изменил практику по договорам", opportunity_state: "used" }),
      item({ id: 4, title: "ФНС обновила форму декларации", opportunity_state: "dismissed" }),
      item({ id: 5, title: "Принят закон о цифровых платформах", status: "posted" }),
    ])).toBe(1);
  });

  it("does not count protocol news or duplicate acts twice", () => {
    expect(unreadLegalOpportunityCount([
      item({
        id: 1,
        title: "Постановление Правительства РФ от 11.08.2026 N 1005",
        summary: "Уточнён перечень товаров.",
      }),
      item({
        id: 2,
        title: "Постановление Правительства Российской Федерации от 11.08.2026 № 1005",
        summary: "О внесении изменения в постановление № 311.",
      }),
      item({
        id: 3,
        title: "Александр Новак встретился с министром энергетики Таиланда",
        summary: "Стороны обсудили сотрудничество.",
        feed_title: "Правительство России",
      }),
    ])).toBe(1);
  });

  it("treats a read duplicate as reading the whole deduplicated event", () => {
    expect(unreadLegalOpportunityCount([
      item({ id: 1 }),
      item({ id: 2, read_at: "2026-08-14T10:00:00.000Z" }),
    ])).toBe(0);
  });

  it("maps cards to new, viewed, used, and hidden visual states", () => {
    expect(legalOpportunityVisualState(item())).toBe("new");
    expect(legalOpportunityVisualState(item({ read_at: "2026-08-14T10:00:00.000Z" }))).toBe("viewed");
    expect(legalOpportunityVisualState(item({ opportunity_state: "saved" }))).toBe("viewed");
    expect(legalOpportunityVisualState(item({ opportunity_state: "used" }))).toBe("used");
    expect(legalOpportunityVisualState(item({ opportunity_state: "dismissed" }))).toBe("hidden");
  });

  it("normalizes values before publishing a client event", () => {
    const dispatchEvent = vi.fn();
    class TestCustomEvent {
      readonly type: string;
      readonly detail: unknown;

      constructor(type: string, init: { detail?: unknown } = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    }
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    emitLegalOpportunityUnreadCount(5.9);
    expect(safeLegalOpportunityUnreadCount(-1)).toBe(0);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: LEGAL_OPPORTUNITY_UNREAD_EVENT,
      detail: { count: 5 },
    }));
    vi.unstubAllGlobals();
  });
});
