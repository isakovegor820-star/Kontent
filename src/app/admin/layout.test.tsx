// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import AdminLayout from "./layout";
const route = vi.hoisted(() => ({ pathname: "/admin" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
afterEach(cleanup);
it("keeps the public admin login outside the dark workspace in initial HTML", () => {
  route.pathname = "/admin/login";
  const html = renderToString(<AdminLayout><main><h1>Вход в центр управления</h1></main></AdminLayout>);
  const host = document.createElement("div"); host.innerHTML = html;
  expect(host.querySelector(".app-v3")).toBeNull();
  expect(host.querySelector("h1")?.textContent).toBe("Вход в центр управления");
});
it.each(["/admin", "/admin/users", "/admin/system", "/admin/analytics", "/admin/projects", "/admin/settings"])("retains workspace styling for protected route %s", pathname => {
  route.pathname = pathname;
  const { container } = render(<AdminLayout><main>Protected workspace</main></AdminLayout>);
  expect(container.querySelector(".app-v3.admin-workspace main")?.textContent).toBe("Protected workspace");
});
it("updates the style boundary in both directions during client navigation", () => {
  route.pathname = "/admin";
  const view = render(<AdminLayout><main>Current page</main></AdminLayout>);
  route.pathname = "/admin/login"; view.rerender(<AdminLayout><main>Current page</main></AdminLayout>);
  expect(view.container.querySelector(".app-v3")).toBeNull();
  route.pathname = "/admin"; view.rerender(<AdminLayout><main>Current page</main></AdminLayout>);
  expect(view.container.querySelector(".app-v3.admin-workspace main")).not.toBeNull();
});
