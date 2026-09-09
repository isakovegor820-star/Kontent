// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectProvider, useProjects } from "./project-provider";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ user: { id: 7 }, authReady: true, toast: mocks.toast }) }));
const project = (id: number) => ({ id, name: `Проект ${id}`, timezone: "UTC", role: "owner", version: 1, personal: false, selected: true, createdAt: "" });
let selected = 1;
let failRead = false;
let put: () => Promise<Response>;
let deferredRead: Promise<Response> | null = null;
let releaseRead: ((value: Response) => void) | null = null;
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
function Probe() {
  const state = useProjects();
  return <>
    <span data-testid="current">{state.current?.name ?? "loading"}</span>
    <button onClick={() => void state.selectProject(2)}>Выбрать Б</button>
    <button onClick={() => void state.refresh()}>Перечитать</button>
    <button onClick={() => void state.createProject({ name: "Проект 3", timezone: "UTC" })}>Создать</button>
    <button>Сохранить контент</button>
  </>;
}
beforeEach(() => {
  selected = 1; failRead = false; deferredRead = null; releaseRead = null;
  put = async () => { selected = 2; return json({ ok: true, project: project(2) }); };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") return put();
    if (init?.method === "POST") { selected = 3; throw new Error("response lost after creation"); }
    if (failRead) throw new Error("network offline");
    if (url === "/api/projects/current" && deferredRead) { const response = deferredRead; deferredRead = null; return response; }
    return url === "/api/projects/current" ? json({ ok: true, project: project(selected) })
      : json({ ok: true, projects: [project(1),project(2)].map((item) => ({ ...item, selected: item.id === selected })) });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function ready() {
  render(<ProjectProvider><Probe /></ProjectProvider>);
  await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Проект 1"));
}
describe("project switching recovery", () => {
  it("updates the header and broadcasts the confirmed context", async () => {
    await ready();
    const listener = vi.fn(); window.addEventListener("aurora:project-changed", listener);
    fireEvent.click(screen.getByText("Выбрать Б"));
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Проект 2"));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detail: { projectId: 2 } }));
    expect(screen.getByText("Сохранить контент").closest("[inert]")).toBeNull();
    window.removeEventListener("aurora:project-changed", listener);
  });
  it("reconciles after the PUT commits but its response is lost", async () => {
    await ready(); put = async () => { selected = 2; throw new Error("lost PUT response"); };
    fireEvent.click(screen.getByText("Выбрать Б"));
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Проект 2"));
    expect(screen.queryByText("Обновить проект")).toBeNull();
  });
  it("keeps the old screen inert until a failed reconciliation can recover", async () => {
    await ready(); put = async () => { selected = 2; failRead = true; throw new Error("offline after commit"); };
    fireEvent.click(screen.getByText("Выбрать Б"));
    await screen.findByText("Обновить проект");
    expect(screen.getByTestId("current").textContent).toBe("Проект 1");
    expect(screen.getByText("Сохранить контент").closest("[inert]")).not.toBeNull();
    failRead = false; fireEvent.click(screen.getByText("Обновить проект"));
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Проект 2"));
    expect(screen.getByText("Сохранить контент").closest("[inert]")).toBeNull();
  });
  it("discards an old refresh response arriving after the switch", async () => {
    await ready();
    deferredRead = new Promise((resolve) => { releaseRead = resolve; });
    fireEvent.click(screen.getByText("Перечитать"));
    fireEvent.click(screen.getByText("Выбрать Б"));
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Проект 2"));
    await act(async () => { releaseRead?.(json({ ok: true, project: project(1) })); });
    expect(screen.getByTestId("current").textContent).toBe("Проект 2");
  });
  it("reconciles an uncertain project creation without keeping project A active", async () => {
    await ready(); fireEvent.click(screen.getByText("Создать"));
    await waitFor(() => expect(screen.getByTestId("current").textContent).toBe("Проект 3"));
  });
});
