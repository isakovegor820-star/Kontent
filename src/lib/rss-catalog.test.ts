import { describe, expect, it } from "vitest";
import { listPublicLegalRssSources, rankRssCatalog, rssCatalogSize } from "./rss-catalog";

describe("RSS catalog", () => {
  it("поднимает право и технологии для смешанной ниши канала", () => {
    const ranked = rankRssCatalog("Технологии права: ИИ для юристов и договоров");
    const recommended = ranked.filter((source) => source.recommended);

    expect(recommended).toHaveLength(6);
    expect(recommended.some((source) => source.id === "consultant")).toBe(true);
    expect(recommended.some((source) => source.id === "habr")).toBe(true);
    expect(ranked[0].category === "Право" || ranked[0].category === "Технологии").toBe(true);
  });

  it("короткие латинские ключи совпадают только целым словом", () => {
    const ranked = rankRssCatalog("Путешествия и городские события");
    expect(ranked.find((source) => source.id === "habr")?.reason).not.toContain("Технологии");
  });

  it("не считает общество совпадением внутри слова сообщество", () => {
    const ranked = rankRssCatalog("Профессиональное сообщество для юристов");
    expect(ranked.find((source) => source.id === "kommersant")?.recommended).toBe(false);
  });

  it("без профиля всё равно предлагает стартовую подборку", () => {
    const ranked = rankRssCatalog("");
    expect(ranked.filter((source) => source.recommended)).toHaveLength(6);
    expect(ranked).toHaveLength(rssCatalogSize());
  });

  it("подбирает профильные криптоисточники для канала о цифровых активах", () => {
    const ranked = rankRssCatalog("Криптовалюты, биткоин, Web3 и новости DeFi");
    const recommendedIds = ranked
      .filter((source) => source.recommended)
      .map((source) => source.id);

    expect(recommendedIds).toContain("coindesk");
    expect(recommendedIds).toContain("cointelegraph");
    expect(recommendedIds).toContain("decrypt");
    expect(ranked[0].category).toBe("Финансы");
  });

  it("автоматически подключает широкую юридическую подборку в устойчивом порядке", () => {
    expect(listPublicLegalRssSources().map((source) => source.id)).toEqual([
      "government",
      "cbr",
      "consultant",
      "garant",
      "pravo-ru",
      "zakon-ru",
    ]);
  });
});
