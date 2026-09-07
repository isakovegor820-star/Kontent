// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountControls } from "./admin-users-center";
import type { AdminUserDetail } from "@/lib/admin-users";
const detail = { user: { id: 42, name: "Receipt fixture", email: "receipt@aurora.test", blockedAt: null, blockedReason: null, aiDailyLimit: null }, adminActions: [] } as unknown as AdminUserDetail;
beforeEach(() => { vi.stubGlobal("React", React); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const receipt = (action = "account.blocked", targetUserId = 42) => new Response(JSON.stringify({ status: "ok", action, targetUserId }), { status: 200 });

it.each([
  ["truncated JSON", () => new Response('{"status":', { status: 200 })],
  ["absent receipt", () => new Response("{}", { status: 200 })],
  ["unconfirmed status", () => new Response(JSON.stringify({ status: "unknown", action: "account.blocked", targetUserId: 42 }), { status: 200 })],
  ["another account", () => receipt("account.blocked", 43)],
  ["another action", () => receipt("account.unblocked")],
] as const)("retains uncertainty and input for %s, then accepts only an explicit confirmed retry", async (_label, response) => {
  const onChanged = vi.fn();
  const request = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(receipt());
  vi.stubGlobal("fetch", request);
  render(<AccountControls detail={detail} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("button", { name: "Заблокировать" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Preserve this reason" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Заблокировать" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Не удалось подтвердить результат");
  expect((within(dialog).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Preserve this reason");
  expect(onChanged).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "Заблокировать" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ action: "block", reason: "Preserve this reason" });
});

it("describes scheduled authority and mail admission without promising an unobserved outcome", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(receipt("account.password_reset_sent")));
  render(<AccountControls detail={detail} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Заблокировать" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("действующих прав отправителя");
  expect(dialog.textContent).not.toContain("запланированные посты продолжат выходить");
  fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
  fireEvent.click(screen.getByRole("button", { name: "Отправить ссылку для сброса" }));
  expect((await screen.findByRole("status")).textContent).toContain("Запрос на отправку ссылки принят");
  expect(screen.queryByText(/Ссылка для сброса пароля отправлена/u)).toBeNull();
});
