// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PublicationBlocksSection } from "./publication-blocks-section";

const project = vi.hoisted(() => ({
  current: { id: 7, role: "owner" as const },
}));

vi.mock("@/components/app/project-provider", () => ({ useProjects: () => project }));
vi.mock("@/lib/project-fetch", () => ({
  projectFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

function block(projectId: number) {
  return {
    id: 1,
    kind: "author_signature",
    name: `Шаблон проекта ${projectId}`,
    text: `Текст проекта ${projectId}`,
    version: 1,
    enabled: true,
    updatedAt: "2026-09-08T10:00:00.000Z",
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("React", React);
  project.current = { id: 7, role: "owner" };
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method) throw new Error("unexpected mutation");
    return new Response(JSON.stringify({ ok: true, blocks: [block(project.current.id)] }));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("publication block project boundary", () => {
  it("discards another project's edit form when the selected project changes", async () => {
    const view = render(<PublicationBlocksSection />);
    await screen.findByText("Шаблон проекта 7");
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Черновик проекта 7" } });

    project.current = { id: 9, role: "owner" };
    view.rerender(<PublicationBlocksSection />);

    await screen.findByText("Шаблон проекта 9");
    await waitFor(() => expect(screen.queryByDisplayValue("Черновик проекта 7")).toBeNull());
    expect(screen.queryByRole("button", { name: "Сохранить шаблон" })).toBeNull();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it("ignores a completed mutation after its project is no longer selected", async () => {
    let finishProjectSevenSave: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Promise<Response>((resolve) => {
          finishProjectSevenSave = resolve;
        });
      }
      return new Response(JSON.stringify({ ok: true, blocks: [block(project.current.id)] }));
    });

    const view = render(<PublicationBlocksSection />);
    await screen.findByText("Шаблон проекта 7");
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    fireEvent.change(screen.getByLabelText("Название"), { target: { value: "Сохранено в проекте 7" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить шаблон" }));
    await waitFor(() => expect(finishProjectSevenSave).toBeTypeOf("function"));

    project.current = { id: 9, role: "owner" };
    view.rerender(<PublicationBlocksSection />);
    await screen.findByText("Шаблон проекта 9");

    finishProjectSevenSave!(new Response(JSON.stringify({
      ok: true,
      block: { ...block(7), name: "Сохранено в проекте 7" },
    })));
    await waitFor(() => expect(screen.getByText("Шаблон проекта 9")).toBeTruthy());
    expect(screen.queryByText("Сохранено в проекте 7")).toBeNull();
    expect(screen.queryByText("Шаблон обновлён.")).toBeNull();
  });
});
