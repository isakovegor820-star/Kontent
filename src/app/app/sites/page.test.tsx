// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import SitesPage from "./page";
const mocked = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/components/app/shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./client", async (load) => ({ ...await load<typeof import("./client")>(), requestJson: mocked.request }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const site = (id: number, name: string) => ({ id, confirmedDomain: name, canonicalUrl: `https://${name}/`, verification: { state: "verified", method: "dns_txt", verifiedAt: null }, publishingMode: "confirm", approvedStreak: 0, autoUnlockStreak: 10, status: "active", latestAnalysis: null, profile: null, reports: [] });
it("retains the selected site's detail when an older site request completes last", async () => {
  vi.stubGlobal("React", React);
  const first = site(1, "first.example"); const second = site(2, "second.example");
  let finishFirst!: (value: unknown) => void;
  mocked.request.mockImplementation(async (url: string) => {
    if (url === "/api/sites") return { status: 200, body: { sites: [first, second] } };
    if (url === "/api/sites/1") return new Promise((resolve) => { finishFirst = resolve; });
    if (url === "/api/sites/2") return { status: 200, body: { site: second, latestAnalysis: null, profile: null, reports: [] } };
    return { status: 200, body: { destinations: [] } };
  });
  render(<SitesPage />);
  await waitFor(() => expect(finishFirst).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: /second\.example/u }));
  expect(await screen.findByRole("heading", { name: "second.example" })).toBeTruthy();
  await act(async () => { finishFirst({ status: 200, body: { site: first, latestAnalysis: null, profile: null, reports: [] } }); });
  expect(screen.getByRole("heading", { name: "second.example" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "first.example" })).toBeNull();
});
it("does not apply an old site's verification response to the newly selected site", async () => {
  vi.stubGlobal("React", React);
  const first = { ...site(1, "first.example"), verification: { state: "unverified", method: null, verifiedAt: null, instructions: { dns: { recordName: "fixture", recordValue: "fixture" }, meta: { tag: "fixture" } } } };
  const second = site(2, "second.example");
  let finishVerify!: (value: unknown) => void;
  mocked.request.mockImplementation(async (url: string) => {
    if (url === "/api/sites") return { status: 200, body: { sites: [first, second] } };
    if (url === "/api/sites/1/verify") return new Promise((resolve) => { finishVerify = resolve; });
    if (url === "/api/sites/1" || url === "/api/sites/2") return { status: 200, body: { site: url.endsWith("1") ? first : second, latestAnalysis: null, profile: null, reports: [] } };
    return { status: 200, body: { destinations: [] } };
  });
  render(<SitesPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Проверить" }));
  await waitFor(() => expect(finishVerify).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: /second\.example/u }));
  expect(await screen.findByRole("heading", { name: "second.example" })).toBeTruthy();
  await act(async () => { finishVerify({ status: 200, body: { ok: true, verified: true, site: site(1, "first.example") } }); });
  expect(screen.getByRole("heading", { name: "second.example" })).toBeTruthy();
});
