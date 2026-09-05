// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProjectInvitePage from "./page";
import { getClientProjectId, projectFetch, setClientProjectId } from "@/lib/project-fetch";
const mocked = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocked.push }) }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ authReady: true, authError: null, user: { id: 1 }, refreshAuth: vi.fn() }) }));
beforeEach(() => { vi.stubGlobal("React", React); setClientProjectId(11); window.history.replaceState({}, "", `/invite#token=${"A".repeat(43)}`); });
afterEach(() => { cleanup(); setClientProjectId(null); window.sessionStorage.clear(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("selects the accepted project in this tab before opening its calendar", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => Response.json(String(input).includes("invitations/accept")
    ? { ok: true, membership: { projectId: 22, role: "reviewer" } } : { ok: true }));
  vi.stubGlobal("fetch", fetcher);
  render(<ProjectInvitePage />);
  fireEvent.click(await screen.findByRole("button", { name: "Принять приглашение" }));
  const open = await screen.findByRole("button", { name: "Открыть проект" });
  expect(getClientProjectId()).toBe(22);
  fireEvent.click(open);
  expect(mocked.push).toHaveBeenCalledWith("/app/calendar");
  await projectFetch("/api/drafts");
  await waitFor(() => expect(new Headers(fetcher.mock.calls.at(-1)?.[1]?.headers).get("x-aurora-project-id")).toBe("22"));
});
