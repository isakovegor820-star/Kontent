// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandDictionarySection } from "./brand-dictionary-section";
import { WritingSettingsSection } from "./writing-settings-section";
import type { ClientBrandDictionary } from "@/lib/brand-dictionary-client";
import { analyzeLegalTypography, applyTypographySuggestions } from "@/lib/legal-typographer";

const project = vi.hoisted(() => ({ current: { id: 7, role: "owner" } }));
vi.mock("@/components/app/project-provider", () => ({ useProjects: () => project }));
let dictionary: ClientBrandDictionary;
let failSave: boolean;
let failLoad: boolean;
let requests: Array<{ method: string; body: Record<string, unknown> }>;

beforeEach(() => {
  project.current = { id: 7, role: "owner" };
  dictionary = { projectId: 7, version: 1, updatedAt: null, entries: [] };
  failSave = false;
  failLoad = false;
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/publication-blocks") return Response.json({ ok: true, blocks: [] });
    if (!init?.method) return failLoad ? Response.json({ ok: false }, { status: 503 }) : Response.json({ ok: true, dictionary });
    const body = JSON.parse(String(init.body));
    requests.push({ method: init.method, body });
    if (failSave) return Response.json({ ok: false, error: "version_conflict" }, { status: 409 });
    if (init.method === "DELETE") dictionary.entries = [];
    else dictionary.entries = [{ ...body, id: 1, version: 1 }];
    dictionary.version += 1;
    return Response.json({ ok: true });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openForm(name = /Писать правильно/) {
  fireEvent.click(await screen.findByRole("button", { name }));
  return screen.getByRole("form", { name: "Новое правило" });
}

function fillReplacement() {
  fireEvent.change(screen.getByLabelText(/Как могут написать/), { target: { value: " аврора " } });
  fireEvent.change(screen.getByLabelText(/Как нужно написать/), { target: { value: "Аврора" } });
}

describe("writing rules user journeys", () => {
  it.each([
    { label: "Писать правильно", kind: "canonical", term: "аврора", replacement: "Аврора", safe: true },
    { label: "Не использовать", kind: "prohibited", term: "лучший на рынке", replacement: "помогает экономить время", safe: false },
    { label: "Использовать сокращение", kind: "abbreviation", term: "искусственный интеллект", replacement: "ИИ", safe: false },
  ])("applies $label exactly as shown in the form", async ({ label, kind, term, replacement, safe }) => {
    render(<BrandDictionarySection />);
    const form = await openForm();
    fireEvent.click(screen.getByRole("radio", { name: label }));
    fireEvent.change(within(form).getAllByRole("textbox")[0], { target: { value: term } });
    fireEvent.change(within(form).getAllByRole("textbox")[1], { target: { value: replacement } });
    fireEvent.submit(form);
    await screen.findByRole("list");
    const suggestions = analyzeLegalTypography(term, { dictionary: dictionary.entries });
    expect(suggestions).toEqual([expect.objectContaining({ before: term, after: replacement, safe, dictionaryKind: kind })]);
    expect(applyTypographySuggestions(term, suggestions, "safe")).toBe(safe ? replacement : term);
    expect(applyTypographySuggestions(term, suggestions, suggestions.map((item) => item.id))).toBe(replacement);
  });

  it.each([
    { label: "Разрешить вариант", protectedText: false },
    { label: "Сохранить как есть", protectedText: true },
  ])("distinguishes $label from the other protection mode", async ({ label, protectedText }) => {
    render(<BrandDictionarySection />);
    const form = await openForm();
    fireEvent.click(screen.getByRole("radio", { name: label }));
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "Идеи -- в дело!" } });
    fireEvent.submit(form);
    await screen.findByRole("list");
    const source = "Идеи -- в дело!";
    const rules = [...dictionary.entries, { kind: "canonical" as const, term: source, replacement: "Другой слоган" }];
    const suggestions = analyzeLegalTypography(source, { dictionary: rules });
    expect(suggestions.some((item) => item.kind === "brand_term")).toBe(false);
    const result = applyTypographySuggestions(source, suggestions, "safe");
    if (protectedText) expect(result).toBe(source);
    else expect(result).toContain("Идеи —");
  });

  it("respects the case setting when checking the saved rule", async () => {
    render(<BrandDictionarySection />);
    const form = await openForm();
    fillReplacement();
    fireEvent.click(screen.getByRole("checkbox", { hidden: true }));
    fireEvent.submit(form);
    await screen.findByRole("list");
    const suggestions = analyzeLegalTypography("АВРОРА, аврора", { dictionary: dictionary.entries });
    expect(suggestions.filter((item) => item.kind === "brand_term")).toEqual([
      expect.objectContaining({ before: "аврора", after: "Аврора" }),
    ]);
  });

  it("explains the purpose before showing a form, previews and saves a rule", async () => {
    render(<BrandDictionarySection />);
    await screen.findByRole("button", { name: "Добавить правило" });
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByText(/Настраивать необязательно/)).toBeTruthy();
    const form = await openForm();
    expect((screen.getByLabelText(/Как могут написать/) as HTMLInputElement).value).toBe("");
    fillReplacement();
    expect(within(form).getByText("Как сработает правило при проверке")).toBeTruthy();
    fireEvent.submit(form);
    await screen.findByRole("list", { name: "Сохранённые правила" });
    expect(screen.queryByRole("form")).toBeNull();
    expect(requests[0]).toEqual({ method: "POST", body: {
      expectedDictionaryVersion: 1, kind: "canonical", term: "аврора", replacement: "Аврора", expansion: null, caseSensitive: false,
    } });
  });

  it("switches to a protected phrase without sending stale replacement or expansion", async () => {
    render(<BrandDictionarySection />);
    const form = await openForm();
    fillReplacement();
    fireEvent.click(screen.getByRole("radio", { name: "Использовать сокращение" }));
    fireEvent.change(screen.getByLabelText(/Расшифровка сокращения/), { target: { value: "Полное название" } });
    fireEvent.click(screen.getByRole("radio", { name: "Сохранить как есть" }));
    expect(screen.queryByLabelText(/Как нужно написать/)).toBeNull();
    expect(screen.queryByLabelText(/Расшифровка сокращения/)).toBeNull();
    fireEvent.submit(form);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].body).toMatchObject({ kind: "exception", replacement: null, expansion: null });
  });

  it("keeps entered text on conflict and allows retry with the refreshed version", async () => {
    render(<BrandDictionarySection />);
    const form = await openForm();
    fillReplacement();
    dictionary.version = 4;
    failSave = true;
    fireEvent.submit(form);
    await screen.findByRole("alert");
    await waitFor(() => expect((screen.getByRole("button", { name: "Сохранить правило" }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText(/Как могут написать/) as HTMLInputElement).value).toBe(" аврора ");
    failSave = false;
    fireEvent.submit(form);
    await screen.findByRole("list");
    expect(requests[1].body.expectedDictionaryVersion).toBe(4);
  });

  it("edits existing rules and only deletes after confirmation", async () => {
    dictionary.entries = [{ id: 1, version: 3, kind: "canonical", term: "аврора", replacement: "Аврора", expansion: null, caseSensitive: true }];
    render(<BrandDictionarySection />);
    fireEvent.click(await screen.findByRole("button", { name: "Изменить правило: аврора" }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText(/Как нужно написать/), { target: { value: "АВРОРА" } });
    fireEvent.submit(screen.getByRole("form"));
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(requests[0]).toMatchObject({ method: "PATCH", body: { expectedEntryVersion: 3, replacement: "АВРОРА" } });
    fireEvent.click(screen.getByRole("button", { name: "Удалить правило: аврора" }));
    expect(requests).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Удалить правило" }));
    await screen.findByText("Пока нет правил — с чего начнём?");
    expect(requests[1].method).toBe("DELETE");
  });

  it("offers retry for a load failure and hides editing from members", async () => {
    failLoad = true;
    project.current.role = "member";
    render(<BrandDictionarySection />);
    await screen.findByText("Не удалось загрузить правила");
    failLoad = false;
    fireEvent.click(screen.getByRole("button", { name: "Загрузить снова" }));
    await screen.findByText(/Добавлять и изменять их может владелец/);
    expect(screen.queryByRole("button", { name: "Добавить правило" })).toBeNull();
  });

  it("keeps an unfinished rule when switching to post templates and back", async () => {
    render(<WritingSettingsSection />);
    await openForm();
    fillReplacement();
    fireEvent.click(screen.getByRole("button", { name: "Шаблоны для постов" }));
    expect(screen.queryByRole("form")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Правила написания" }));
    expect((screen.getByLabelText(/Как могут написать/) as HTMLInputElement).value).toBe(" аврора ");
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(requests).toHaveLength(0);
    expect(screen.queryByRole("form")).toBeNull();
  });
});
