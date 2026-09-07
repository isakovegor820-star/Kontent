// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminPublicationItem, AdminPublicationsResponse } from "@/lib/admin-publications";
import { AdminPublicationsCenter } from "./admin-publications-center";
import { adminFetchMock } from "./__fixtures__/admin-payloads";

beforeEach(() => {
  window.history.replaceState({}, "", "/admin?pstatus=all#publications");
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show(status: string) {
  const item: AdminPublicationItem = {
    id: 41, projectId: 7, project: "Synthetic project", authorId: 3, author: "Synthetic author",
    channelId: 9, channel: "Synthetic channel", network: "tg", channelStatus: "active",
    status, attention: null, attempts: 1, errorCode: null, text: "Synthetic publication",
    origin: "manual", hasMedia: false, operationId: 11, scheduledAt: null,
    publishedAt: status === "published" ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(), inFlight: false,
    canRetry: false, canCancel: false, canReschedule: false,
  };
  const data: AdminPublicationsResponse = {
    checkedAt: new Date().toISOString(), items: [item],
    summary: { attention: 0, failed: 0, quarantined: 0, overdue: 0, failedRetry: 0,
      scheduled: 0, publishing: 0, publishedUnverified: status === "published_unverified" ? 1 : 0,
      publishedToday: status === "published" ? 1 : 0, total: 1 },
    pagination: { page: 1, pageSize: 25, total: 1, pages: 1 },
    options: { networks: ["tg"], errorCodes: [], projects: [{ id: 7, label: "Synthetic project" }] },
  };
  const requests = vi.fn(adminFetchMock({ "/api/admin/publications": () => data }));
  vi.stubGlobal("fetch", requests);
  render(<AdminPublicationsCenter />);
  return requests;
}

it("keeps unconfirmed delivery unresolved in both the table and narrow card", async () => {
  const requests = show("published_unverified");
  await screen.findAllByText("Synthetic publication");
  expect(screen.getAllByText("Доставка не подтверждена", { exact: true })).toHaveLength(2);
  expect(screen.getAllByText(/Соцсеть могла принять пост, но подтверждение не получено/u)).toHaveLength(2);
  expect(document.body.textContent).not.toContain("Отправка принята");
  expect(document.body.textContent).not.toContain("Опубликован, проверка ожидается");
  expect(screen.queryByRole("button", { name: "Повторить попытку" })).toBeNull();
  expect(requests.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
});

it("retains the confirmed publication label for a successful receipt", async () => {
  show("published");
  expect(await screen.findAllByText("Опубликован", { exact: true })).toHaveLength(2);
  expect(screen.queryByText("Доставка не подтверждена", { exact: true })).toBeNull();
});
