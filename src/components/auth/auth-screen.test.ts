import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const authScreen = readFileSync(new URL("./auth-screen.tsx", import.meta.url), "utf8");
const registerPage = readFileSync(new URL("../../app/register/page.tsx", import.meta.url), "utf8");
const loginPage = readFileSync(new URL("../../app/login/page.tsx", import.meta.url), "utf8");

describe("public authentication flow", () => {
  it("keeps registration and login on separate public routes", () => {
    expect(registerPage).toContain('<AuthScreen mode="register" />');
    expect(loginPage).toContain('<AuthScreen mode="login" />');
    expect(authScreen).toContain('href={isRegistration ? "/login" : "/register"}');
  });

  it("creates the correct session and opens the platform after success", () => {
    expect(authScreen).toContain('isRegistration ? "/api/auth/register" : "/api/auth/login"');
    expect(authScreen).toContain('router.replace(signedInDestination())');
    expect(authScreen).toContain('"/app/calendar"');
  });
});
