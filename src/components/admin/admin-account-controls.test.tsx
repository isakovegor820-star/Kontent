// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AccountControls } from "./admin-users-center";
import type { AdminUserDetail } from "@/lib/admin-users";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("contains block-dialog keyboard focus and lets Escape cancel before a destructive action", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("fetch", vi.fn());
  const detail = { user: { id: 1, name: "Fixture", email: null, blockedAt: null, blockedReason: null, aiDailyLimit: null }, adminActions: [] } as unknown as AdminUserDetail;
  render(<AccountControls detail={detail} onChanged={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "Заблокировать" });
  trigger.focus(); fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog");
  const cancel = within(dialog).getByRole("button", { name: "Отмена" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  const confirm = within(dialog).getByRole("button", { name: "Заблокировать" });
  confirm.focus(); expect(fireEvent.keyDown(confirm, { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(within(dialog).getByRole("textbox"));
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(fetch).not.toHaveBeenCalled();
});
