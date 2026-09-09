// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthScreen, type AuthIntent, type AuthMode } from "./auth-screen";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock("@/components/brand", () => ({ Logo: () => null }));
vi.mock("@/components/landing/hero-product-scene", () => ({ HeroProductScene: () => null }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ authReady: false, user: null, refreshAuth: vi.fn(), toast: vi.fn() }) }));
const fetchMock = vi.fn(); let root: Root | undefined; let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host);
  fetchMock.mockReset().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "invalid" }) });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { if (root) await act(async () => root?.unmount()); root = undefined; host.remove(); vi.unstubAllGlobals(); });
const identity = { name: "QA Автор", email: "qa-hydration@aurora.test", password: "QA-native-entry-2026" };
function fillNative() {
  for (const [name, value] of Object.entries(identity)) {
    const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (input) input.value = value;
  }
}
const variants: { mode: AuthMode; intent: AuthIntent }[] = [
  { mode: "login", intent: "platform" }, { mode: "login", intent: "admin" }, { mode: "register", intent: "platform" },
];
for (const props of variants) {
  it.each(["before-hydration", "autofill-after-hydration"])(`${props.mode}/${props.intent}: sends the visible native values from %s`, async (when) => {
    host.innerHTML = renderToString(<AuthScreen {...props} />);
    if (when === "before-hydration") fillNative();
    await act(async () => { root = hydrateRoot(host, <AuthScreen {...props} />); });
    if (when === "autofill-after-hydration") fillNative();
    // A local UI rerender must not erase values that predate React's listeners.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Показать пароль" })));
    expect(host.querySelector<HTMLInputElement>("#email")?.value).toBe(identity.email);
    expect(host.querySelector<HTMLInputElement>("#password")?.value).toBe(identity.password);
    await act(async () => fireEvent.submit(host.querySelector("form")!));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe(props.mode === "register" ? "/api/auth/register" : "/api/auth/login");
    expect(JSON.parse(init.body)).toEqual({ email: identity.email, password: identity.password,
      ...(props.mode === "register" ? { name: identity.name } : {}) });
  });
  it(`${props.mode}/${props.intent}: empty values still fail validation and focus the first invalid control`, async () => {
    host.innerHTML = renderToString(<AuthScreen {...props} />);
    await act(async () => { root = hydrateRoot(host, <AuthScreen {...props} />); });
    await act(async () => fireEvent.submit(host.querySelector("form")!));
    expect(fetchMock).not.toHaveBeenCalled();
    const expected = props.mode === "register" ? "#name" : "#email";
    expect(document.activeElement).toBe(host.querySelector(expected));
    expect(host.querySelector(expected)?.getAttribute("aria-invalid")).toBe("true");
  });
}
