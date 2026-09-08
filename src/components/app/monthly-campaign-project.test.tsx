// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectProvider } from "./project-provider";
import { MonthlyCampaignPlanner } from "./monthly-campaign-planner";
import { selectedProjectDto } from "@/lib/project-dto";
import { setProjectTransport } from "@/lib/project-transport";

const mocks = vi.hoisted(() => ({ toast: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ user: { id: 3 }, authReady: true, toast: mocks.toast, realChannels: [] }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
afterEach(() => { cleanup(); setProjectTransport(null); vi.unstubAllGlobals(); });

it("opens an owner's monthly form from the shared DTO and does not reread another session's selected project", async () => {
  const a = selectedProjectDto({ projectId: 7, name: "Editorial A", timezone: "UTC", role: "owner", version: 1, personal: false });
  const b = selectedProjectDto({ projectId: 8, name: "Editorial B", timezone: "UTC", role: "publisher", version: 1, personal: false });
  let contextReads = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/projects/current") return Response.json({ ok: true, project: ++contextReads === 1 ? a : b });
    if (url === "/api/projects") return Response.json({ ok: true, projects: [a, { ...b, selected: false }] });
    expect(url).toBe("/api/monthly-campaigns");
    expect(new Headers(init?.headers).get("x-aurora-project-id")).toBe("7");
    return Response.json({ ok: true, campaigns: [] }, { headers: { "x-aurora-project-id": "7" } });
  });
  vi.stubGlobal("fetch", fetch);
  render(<ProjectProvider><MonthlyCampaignPlanner /></ProjectProvider>);
  expect(await screen.findByRole("heading", { name: "Сетка тем на месяц" })).toBeTruthy();
  expect(screen.getByLabelText(/Цель кампании/)).toBeTruthy();
  expect(screen.queryByText("Не удалось загрузить кампании. Обнови страницу.")).toBeNull();
  expect(contextReads).toBe(1);
});
