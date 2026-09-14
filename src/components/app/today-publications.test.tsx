// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TodayPublications } from "./today-publications";
import type { TodayPublication } from "@/lib/today-publications";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/use-project-transport", () => ({ useProjectFetch: () => mocks.fetch }));

const item: TodayPublication = { key: "draft:41", draftId: 41, draftVersion: 3, text: "Согласованный материал", media: undefined,
  status: "approved", scheduledAt: null, href: "/app/composer?draft=41", canPublish: true };
const props = { projectId: 7, channelId: 11, channelLabel: "Канал", timezone: "Europe/Amsterdam", available: true, onRefresh: vi.fn() };
function mount(overrides: Partial<TodayPublication> = {}) {
  render(<TodayPublications {...props} items={[{ ...item, ...overrides }]} />);
  fireEvent.click(screen.getByRole("heading", { name: "Согласованный материал" }));
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

it("opening a preview does not publish; an explicit action uses the current revision and project", async () => {
  mocks.fetch.mockResolvedValue(Response.json({ ok: true, result: "queued", operationId: 81, operationStatus: "queued" }));
  mount();
  expect(mocks.fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Опубликовать сейчас" }));
  await waitFor(() => expect(props.onRefresh).toHaveBeenCalledTimes(1));
  expect(props.onRefresh).toHaveBeenCalledWith(expect.stringContaining("Публикация в очереди"));
  const [url, request] = mocks.fetch.mock.calls[0];
  expect(url).toBe("/api/publication-operations");
  expect(JSON.parse(request.body)).toMatchObject({ draftId: 41, draftVersion: 3, timezone: "Europe/Amsterdam" });
  expect(request.headers["x-aurora-project-id"]).toBe("7");
  expect(screen.getByRole("status").textContent).toContain("в очереди");
  expect(screen.queryByText("Опубликовано")).toBeNull();
});

it("retries an uncertain response with the exact same idempotency key and schedule", async () => {
  mocks.fetch.mockRejectedValueOnce(new Error("lost response"));
  mocks.fetch.mockResolvedValueOnce(Response.json({ ok: true, result: "queued", operationId: 81 }));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Опубликовать сейчас" }));
  await screen.findByRole("alert");
  await waitFor(() => expect(screen.getByRole("button", { name: "Повторить отправку запроса" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Повторить отправку запроса" }));
  await waitFor(() => expect(props.onRefresh).toHaveBeenCalled());
  expect(mocks.fetch.mock.calls[0][1].body).toBe(mocks.fetch.mock.calls[1][1].body);
  expect(mocks.fetch.mock.calls[0][1].headers["idempotency-key"]).toBe(mocks.fetch.mock.calls[1][1].headers["idempotency-key"]);
});

it("does not offer direct publication for an unapproved draft or a read-only member", () => {
  mount({ canPublish: false, status: "draft" });
  expect(screen.queryByRole("button", { name: "Опубликовать сейчас" })).toBeNull();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("rejects a past time locally and keeps the time editable", async () => {
  mount();
  fireEvent.change(screen.getByLabelText("Время публикации"), { target: { value: "2020-01-01T12:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Запланировать" }));
  expect(screen.getByRole("alert").textContent).toContain("в будущем");
  expect(screen.getByLabelText("Время публикации").hasAttribute("disabled")).toBe(false);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
