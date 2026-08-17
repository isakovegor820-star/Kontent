import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { validateTelegramMiniAppData } from "./telegram-mini-app";

function signedData(token: string, values: Record<string, string>) {
  const check = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...values, hash }).toString();
}

describe("Telegram Mini App init data", () => {
  it("accepts a current signature and extracts the Telegram user", () => {
    const data = signedData("bot-token", {
      auth_date: "1000",
      query_id: "query-1",
      user: JSON.stringify({ id: 8877, first_name: "Егор" }),
    });
    expect(validateTelegramMiniAppData(data, "bot-token", { nowSeconds: 1050 })).toEqual({
      userId: 8877,
      authDate: 1000,
      queryId: "query-1",
    });
  });

  it("rejects forged and expired payloads", () => {
    const data = signedData("bot-token", { auth_date: "1000", user: JSON.stringify({ id: 8877 }) });
    expect(validateTelegramMiniAppData(data.replace("8877", "8878"), "bot-token", { nowSeconds: 1050 })).toBeNull();
    expect(validateTelegramMiniAppData(data, "bot-token", { nowSeconds: 2000 })).toBeNull();
  });
});
