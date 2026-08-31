import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./account-profile-settings.tsx", import.meta.url), "utf8");

describe("account profile phone capability", () => {
  it("renders the temporary flow only when the server advertises it", () => {
    expect(source).toContain('phoneVerificationState === "temporary"');
    expect(source).toContain("Подтверждение телефона появится после подключения провайдера доставки кодов.");
    expect(source).not.toContain("AURORA_TEMPORARY_PHONE_VERIFICATION");
  });
});
