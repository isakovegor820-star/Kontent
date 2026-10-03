import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const authScreen = readFileSync(new URL("./auth-screen.tsx", import.meta.url), "utf8");
const registerPage = readFileSync(new URL("../../app/register/page.tsx", import.meta.url), "utf8");
const loginPage = readFileSync(new URL("../../app/login/page.tsx", import.meta.url), "utf8");
const adminLoginPage = readFileSync(new URL("../../app/admin/login/page.tsx", import.meta.url), "utf8");
const adminDashboard = readFileSync(new URL("../admin/admin-dashboard.tsx", import.meta.url), "utf8");

describe("public authentication flow", () => {
  it("keeps registration and login on separate public routes", () => {
    expect(registerPage).toContain('<AuthScreen mode="register" />');
    expect(loginPage).toContain('<AuthScreen mode="login" />');
    expect(authScreen).toContain('href={isRegistration ? "/login" : "/register"}');
    expect(authScreen).toContain('href="/terms"');
    expect(authScreen).toContain('href="/privacy"');
    expect(authScreen).not.toContain("14 дней бесплатно");
  });

  it("creates the correct session and routes unfinished accounts to onboarding", () => {
    expect(authScreen).toContain('isRegistration ? "/api/auth/register" : "/api/auth/login"');
    expect(authScreen).toContain("router.replace(signedInDestination(intent, store.user.onboarded))");
    expect(authScreen).toContain('if (!onboarded) return "/app/onboarding"');
    expect(authScreen).toContain('"/app/calendar"');
  });

  it("provides a dedicated administrator entry without exposing registration", () => {
    expect(adminLoginPage).toContain('<AuthScreen mode="login" intent="admin" />');
    expect(authScreen).toContain('if (intent === "admin") return "/admin#overview"');
    expect(authScreen).toContain('isAdmin ? "Войти в админ-панель"');
    expect(authScreen).toContain("{!isAdmin ? (");
    expect(authScreen).toContain("!isRegistration && !isAdmin");
    expect(adminDashboard).toContain('href="/admin/login"');
  });

  // Согласие на обработку ПДн: раньше под формой была пассивная фраза, и
  // регистрация уходила на сервер без согласия. Теперь это отдельный флажок,
  // который по умолчанию снят и блокирует отправку (ч. 1 ст. 9 152-ФЗ).
  it("requires an explicit consent checkbox for registration", () => {
    expect(authScreen).toContain('id="pd-consent"');
    expect(authScreen).toContain('name="consent"');
    expect(authScreen).toContain('type="checkbox"');
    expect(authScreen).toContain("required");
    expect(authScreen).toContain("checked={consent}");
    expect(authScreen).toContain("useState(false)");
    // Текст согласия говорит про обработку ПДн и ссылается на документы.
    expect(authScreen).toContain("Даю согласие на обработку персональных данных");
    expect(authScreen).toContain('href="/consent"');
  });

  it("does not send the registration request until consent is given", () => {
    // Проверка стоит в submit до fetch: без согласия запрос не уходит вовсе.
    expect(authScreen).toContain("const nextConsentError =");
    expect(authScreen).toContain("if (nextConsentError) {");
    expect(authScreen).toContain("consentRef.current?.focus()");
    // Согласие передаётся в теле запроса вместе с остальными полями.
    expect(authScreen).toContain("...(isRegistration ? { name: name.trim(), consent } : {})");
  });
});
