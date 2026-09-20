import { describe, expect, it } from "vitest";

import { buildOpportunityDiscoveryQueries } from "./opportunity-market-discovery.mjs";

describe("channel opportunity discovery queries", () => {
  it("builds bounded searches for news, rising discussion and audience needs", () => {
    const queries = buildOpportunityDiscoveryQueries({
      niche: "Маркетинг для малого бизнеса",
      rubrics: ["Продажи", "Контент"],
      keywords: ["нейросети", "лидогенерация"],
    });

    expect(queries.map((item) => item.family)).toEqual(["current", "rising", "needs"]);
    expect(queries[0]?.query).toContain("нейросети продажи маркетинг для малого бизнеса");
    expect(queries[1]?.query).toContain("что набирает популярность");
    expect(queries[2]?.query).toContain("практический опыт");
    expect(queries.every((item) => item.query.length <= 200)).toBe(true);
  });

  it("normalizes unsafe spacing and punctuation without losing channel specificity", () => {
    const queries = buildOpportunityDiscoveryQueries({
      niche: "  B2B\n SaaS  ",
      rubrics: ["CRM!!!"],
      keywords: [],
    });

    expect(queries).toHaveLength(3);
    expect(queries.every((item) => item.query.includes("b2b saas"))).toBe(true);
    expect(queries.every((item) => !item.query.includes("!"))).toBe(true);
  });
});
