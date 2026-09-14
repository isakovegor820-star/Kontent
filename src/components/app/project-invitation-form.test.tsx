// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectTeamSection } from "./project-team-section";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  projects: {
    current: { id: 7, name: "Team", role: "owner", timezone: "UTC" },
    ready: true, switching: false, error: false, refresh: vi.fn(), createProject: vi.fn(),
  },
}));
vi.mock("@/components/app/project-provider", () => ({ useProjects: () => mocks.projects }));
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps the server recipient next to the generated URL after clearing the form and removes that URL after revoke", async () => {
  const inviteUrl = `https://aurora.test/invite#token=${"j".repeat(43)}`;
  mocks.fetch.mockImplementation(async (_url: string, init?: RequestInit) => ({
    ok: true,
    json: async () => init?.method === "POST" ? {
      ok: true, inviteUrl,
      invitation: {
        id: 8, email: "recipient@example.test", role: "author", status: "pending",
        expiresAt: "2099-01-01T00:00:00Z", createdAt: "2026-09-08T00:00:00Z", acceptedAt: null, revokedAt: null,
      },
    } : init?.method === "DELETE" ? { ok: true } : { ok: true, members: [], invitations: [] },
  }));
  render(<ProjectTeamSection />);
  const create = screen.getByRole("button", { name: "Создать приглашение" });
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Электронная почта", { exact: false }), { target: { value: "Recipient@Example.Test" } });
  fireEvent.click(create);
  const ready = await screen.findByRole("status", { name: "Ссылка приглашения готова" });
  expect(within(ready).getByText("recipient@example.test")).toBeTruthy();
  expect((screen.getByLabelText("Электронная почта", { exact: false }) as HTMLInputElement).value).toBe("");
  expect((within(ready).getByRole("textbox", { name: "Одноразовая ссылка приглашения" }) as HTMLInputElement).value).toBe(inviteUrl);
  fireEvent.click(screen.getByRole("button", { name: "Отозвать" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Отозвать приглашение" }));
  await waitFor(() => expect(screen.queryByRole("status", { name: "Ссылка приглашения готова" })).toBeNull());
});
