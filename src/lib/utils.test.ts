// Тесты чистых помощников форматирования (src/lib/utils.ts).
// Intl-зависимые функции проверяем мягко (формат может слегка отличаться по ICU-версиям).
import { describe, it, expect } from "vitest";
import {
  fmtNum,
  fmtCompact,
  fmtPct,
  plural,
  initials,
  channelHue,
  isoDay,
  atTime,
  seeded,
  fmtAgo,
} from "./utils";

describe("fmtNum", () => {
  it("числа до тысячи без разделителя", () => {
    expect(fmtNum(999)).toBe("999");
  });
  it("тысячи разделяются пробелом", () => {
    expect(fmtNum(12345).replace(/\s/g, "")).toBe("12345");
    expect(fmtNum(12345)).not.toBe("12345");
  });
});

describe("fmtCompact", () => {
  it("до тысячи — как есть", () => {
    expect(fmtCompact(500)).toBe("500");
  });
  it("тысячи — компактно", () => {
    expect(fmtCompact(12345)).toMatch(/тыс/);
  });
});

describe("fmtPct", () => {
  it("без знака по умолчанию", () => {
    expect(fmtPct(5)).toBe("5%");
  });
  it("со знаком", () => {
    expect(fmtPct(5, true)).toBe("+5%");
    expect(fmtPct(-3, true)).toBe("−3%");
    expect(fmtPct(0, true)).toBe("0%");
  });
});

describe("plural", () => {
  const p = (n: number) => plural(n, "пост", "поста", "постов");
  it("формы", () => {
    expect(p(1)).toBe("пост");
    expect(p(2)).toBe("поста");
    expect(p(5)).toBe("постов");
    expect(p(11)).toBe("постов");
    expect(p(21)).toBe("пост");
  });
});

describe("initials", () => {
  it("первые буквы значимых слов", () => {
    expect(initials("ТехнологИИ Права")).toBe("ТП");
  });
  it("пропускает односимвольные слова", () => {
    expect(initials("Кофе и код")).toBe("КК");
  });
  it("одно слово и пустота", () => {
    expect(initials("Одно")).toBe("О");
    expect(initials("")).toBe("?");
  });
});

describe("channelHue", () => {
  it("детерминирован и в диапазоне", () => {
    expect(channelHue(5)).toBe(channelHue(5));
    expect(channelHue("abc")).toBe(channelHue("abc"));
    const h = channelHue(42);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});

describe("isoDay", () => {
  it("понедельник = 0, воскресенье = 6", () => {
    expect(isoDay(new Date(2024, 0, 1))).toBe(0); // понедельник
    expect(isoDay(new Date(2024, 0, 7))).toBe(6); // воскресенье
  });
});

describe("atTime", () => {
  it("ставит часы и минуты", () => {
    const d = atTime(new Date(2024, 0, 1), "14:30");
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });
});

describe("seeded", () => {
  it("детерминированный генератор", () => {
    const a = seeded(42);
    const b = seeded(42);
    expect(a()).toBe(b());
    const v = a();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});

describe("fmtAgo", () => {
  it("человеческие интервалы", () => {
    expect(fmtAgo(new Date(Date.now()).toISOString())).toBe("только что");
    expect(fmtAgo(new Date(Date.now() - 5 * 60000).toISOString())).toBe("5 мин назад");
    expect(fmtAgo(new Date(Date.now() - 3 * 3600000).toISOString())).toBe("3 часа назад");
  });
});
