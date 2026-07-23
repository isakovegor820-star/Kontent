// Тесты чистого извлечения IP клиента. checkRateLimit не тестируем — ему нужен
// живой Redis (а он поднимается лениво только внутри checkRateLimit, поэтому сам
// импорт модуля в тестах безопасен и не создаёт соединений).
import { describe, it, expect } from "vitest";
import { clientIp } from "./rate-limit";

function reqWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/x", { headers });
}

describe("clientIp", () => {
  it("берёт первый хоп из x-forwarded-for", () => {
    const ip = clientIp(reqWith({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9" }));
    expect(ip).toBe("1.2.3.4");
  });

  it("одиночный x-forwarded-for", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": "8.8.8.8" }))).toBe("8.8.8.8");
  });

  it("fallback на x-real-ip, когда нет x-forwarded-for", () => {
    expect(clientIp(reqWith({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("приоритет у x-forwarded-for перед x-real-ip", () => {
    const ip = clientIp(reqWith({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }));
    expect(ip).toBe("1.1.1.1");
  });

  it("нет заголовков — unknown", () => {
    expect(clientIp(reqWith({}))).toBe("unknown");
  });
});
