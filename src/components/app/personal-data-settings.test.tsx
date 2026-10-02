// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));

import { PersonalDataSettings } from "./personal-data-settings";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob([JSON.stringify(body)], { type: "application/json" })),
    headers: new Headers({ "content-disposition": 'attachment; filename="aurora-personal-data-7.json"' }),
  } as unknown as Response);
}

describe("personal data settings section", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    // Скачивание в jsdom: createObjectURL и click по ссылке не реализованы.
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    }));
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("account-deletion") && init?.method === "POST") {
        return jsonResponse({ ok: true, deleted: true });
      }
      if (String(url).includes("account-deletion")) {
        return jsonResponse({ ok: true, personalProjects: 1, blockers: [] });
      }
      return jsonResponse({ ok: true, account: { id: 7 } });
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows what will be deleted before anything irreversible", async () => {
    render(<PersonalDataSettings />);
    expect(await screen.findByText("Выгрузка данных")).toBeTruthy();
    expect(screen.getByText("Удаление аккаунта")).toBeTruthy();
    // Число личных проектов видно заранее: удаление не должно быть сюрпризом.
    await waitFor(() => {
      expect(screen.getByText("1")).toBeTruthy();
    });
  });

  it("keeps the delete button disabled until the consequences are accepted", async () => {
    render(<PersonalDataSettings />);
    const remove = await screen.findByRole("button", { name: "Удалить аккаунт" });
    expect((remove as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Удалить аккаунт" }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("deletes only after the confirmation dialog", async () => {
    render(<PersonalDataSettings />);
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Удалить аккаунт" }));

    // Сначала диалог с явным подтверждением, запроса ещё нет.
    expect(await screen.findByText("Удалить аккаунт навсегда?")).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST")).toHaveLength(0);

    const dialogConfirm = screen.getAllByRole("button", { name: "Удалить аккаунт" }).at(-1) as HTMLButtonElement;
    fireEvent.click(dialogConfirm);

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST");
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({ confirm: true });
    });
    // После удаления сессии нет — уводим на страницу входа.
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/login?deleted=1"));
  });

  it("downloads the export as a file", async () => {
    render(<PersonalDataSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Скачать мои данные" }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/settings/personal-data"))).toBe(true);
    });
    expect(await screen.findByText("Файл сформирован")).toBeTruthy();
  });

  it("explains a blocked deletion instead of pretending it worked", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("account-deletion") && init?.method === "POST") {
        return jsonResponse({ ok: false, error: "shared_project_owner" }, 409);
      }
      if (String(url).includes("account-deletion")) {
        return jsonResponse({
          ok: true,
          personalProjects: 0,
          blockers: [{ id: 5, name: "Командный" }],
          orphanedProjects: [],
          transferCandidates: [],
        });
      }
      return jsonResponse({ ok: true });
    });
    render(<PersonalDataSettings />);

    // Командный проект без владельца: кнопка заблокирована, причина названа.
    expect(await screen.findByText(/Командный/)).toBeTruthy();
    const remove = screen.getByRole("button", { name: "Удалить аккаунт" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
  });

  it("offers the project members to hand the project over to", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("account-deletion") && init?.method === "POST") {
        return jsonResponse({ ok: true, deleted: true });
      }
      if (String(url).includes("account-deletion")) {
        return jsonResponse({
          ok: true,
          personalProjects: 0,
          blockers: [{ id: 5, name: "Командный" }],
          orphanedProjects: [],
          transferCandidates: [{ userId: 9, name: "Коллега", role: "author" }],
        });
      }
      return jsonResponse({ ok: true });
    });
    render(<PersonalDataSettings />);

    // Кандидатов отдаёт сервер, и самого владельца в списке нет.
    const select = await screen.findByRole("combobox");
    const options = Array.from((select as HTMLSelectElement).options).map((option) => option.textContent);
    expect(options).toEqual(["Выберите участника", "Коллега"]);

    fireEvent.click(screen.getByRole("checkbox"));
    const remove = screen.getByRole("button", { name: "Удалить аккаунт" }) as HTMLButtonElement;
    // Без выбранного участника удаление недоступно: проект нельзя осиротить.
    expect(remove.disabled).toBe(true);

    fireEvent.change(select, { target: { value: "9" } });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "Удалить аккаунт" }) as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: "Удалить аккаунт" }));
    const dialogConfirm = screen.getAllByRole("button", { name: "Удалить аккаунт" }).at(-1) as HTMLButtonElement;
    fireEvent.click(dialogConfirm);
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST");
      expect(JSON.parse(String((posts[0][1] as RequestInit).body))).toEqual({ confirm: true, transferSharedTo: 9 });
    });
  });

  it("explains when there is nobody to hand the project over to", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("account-deletion")) {
        return jsonResponse({
          ok: true,
          personalProjects: 0,
          blockers: [{ id: 5, name: "Командный" }],
          orphanedProjects: [],
          // Общего кандидата нет: передать все проекты одному человеку нельзя.
          transferCandidates: [],
        });
      }
      return jsonResponse({ ok: true });
    });
    render(<PersonalDataSettings />);

    // Единственный участник — сам владелец: передать некому, и об этом сказано.
    expect(await screen.findByText(/нет общего участника/u)).toBeTruthy();
    // Селектора передачи нет: выбирать не из кого.
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("does not offer a transfer when there is no blocker", async () => {
    render(<PersonalDataSettings />);
    await screen.findByText("Выгрузка данных");
    // Личный проект удаляется целиком, передавать нечего — выбора участника нет.
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("says out loud that projects without other members will be deleted", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("account-deletion")) {
        return jsonResponse({
          ok: true,
          personalProjects: 2,
          blockers: [],
          orphanedProjects: [{ id: 6, name: "Одинокий проект" }],
          transferCandidates: [],
        });
      }
      return jsonResponse({ ok: true });
    });
    render(<PersonalDataSettings />);

    // Человек должен видеть, что проект уйдёт вместе с аккаунтом: это часть
    // последствий, а не сюрприз после подтверждения.
    expect(await screen.findByText(/Одинокий проект/u)).toBeTruthy();
    expect(screen.getByText(/удалятся вместе с аккаунтом/u)).toBeTruthy();
    // Передавать нечего — селекта нет, но удаление доступно.
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("button", { name: "Удалить аккаунт" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains a stale transfer choice instead of blaming the network", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("account-deletion") && init?.method === "POST") {
        return jsonResponse({ ok: false, error: "invalid_transfer_target" }, 422);
      }
      if (String(url).includes("account-deletion")) {
        return jsonResponse({
          ok: true,
          personalProjects: 0,
          blockers: [{ id: 5, name: "Командный" }],
          orphanedProjects: [],
          transferCandidates: [{ userId: 9, name: "Коллега", role: "author" }],
        });
      }
      return jsonResponse({ ok: true });
    });
    render(<PersonalDataSettings />);
    const select = await screen.findByRole("combobox");
    fireEvent.change(select, { target: { value: "9" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Удалить аккаунт" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Удалить аккаунт" }).at(-1) as HTMLButtonElement);

    // Повторять запрос бессмысленно: состав участников изменился.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/обновите список/iu);
  });
});
