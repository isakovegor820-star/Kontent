// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ current: { id: 41 } as { id: number } | null, ready: true, switching: false, selectProject: vi.fn() }));
vi.mock("./project-provider", () => ({ useProjects: () => mocks }));
import { useOAuthReturnProject } from "./use-oauth-return-project";
let root: Root; let host: HTMLDivElement;
function Probe({ active = true, id = "23" }: { active?: boolean; id?: string | null }) {
  return <p>{useOAuthReturnProject(active, id)}</p>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.current = { id: 41 }; mocks.ready = true; mocks.switching = false; mocks.selectProject.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe("OAuth return project alignment", () => {
  it("withholds success until the initiating project has actually been selected", async () => {
    let resolve!: (value: boolean) => void;
    mocks.selectProject.mockImplementation(() => new Promise<boolean>((done) => { resolve = done; }));
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe("pending"); expect(mocks.selectProject).toHaveBeenCalledWith(23);
    await act(async () => { resolve(true); });
    expect(host.textContent).toBe("pending");
    mocks.current = { id: 23 };
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe("ready"); expect(mocks.selectProject).toHaveBeenCalledOnce();
  });
  it("fails closed when the returned project is revoked or the switch fails", async () => {
    mocks.selectProject.mockResolvedValue(false);
    await act(async () => root.render(<Probe />));
    expect(host.textContent).toBe("forbidden"); expect(mocks.current?.id).toBe(41);
  });
  it("does not switch for malformed or missing callback project context", async () => {
    await act(async () => root.render(<Probe id={null} />));
    expect(host.textContent).toBe("forbidden");
    await act(async () => root.render(<Probe id="23&projectId=41" />));
    expect(host.textContent).toBe("forbidden"); expect(mocks.selectProject).not.toHaveBeenCalled();
  });
});
