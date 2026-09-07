// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClientProjectId } from "@/lib/project-fetch";
import { AutopilotCalendar, type AutopilotCalendarItem } from "./autopilot-calendar";

const pending: AutopilotCalendarItem = { id: "plan-7-0", planIndex: 0, scheduledAt: "2026-09-07T09:00:00Z", title: "Первый пост", text: "Полный текст публикации", state: "review", statusLabel: "Не добавлен в календарь", selectable: true, editable: true, issues: [] };
const scheduled: AutopilotCalendarItem = { ...pending, id: "real-51", planIndex: undefined, postId: 51, title: "Пост в календаре", state: "scheduled", statusLabel: "В основном календаре", selectable: false };
const blocked: AutopilotCalendarItem = { ...pending, id: "plan-7-1", planIndex: 1, title: "Проверить факты", statusLabel: "Нужна проверка", selectable: false, issues: ["Проверь источник"] };
const edit = vi.fn(); const add = vi.fn(); const move = vi.fn(async () => true);
function Harness({ returnItemId, media }: { returnItemId?: string; media?: unknown }) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  return <AutopilotCalendar items={[{ ...pending, media }, scheduled, blocked]} selected={selected} busy={false} channelName="Тестовый канал" storageKey="qa:autopilot" returnItemId={returnItemId}
    onSelect={(index) => setSelected((previous) => previous.has(index) ? new Set() : new Set([index]))} onSelectAll={(indexes) => setSelected(new Set(indexes))} onAdd={add} onEdit={edit} onReschedule={move} />;
}
beforeEach(() => { vi.stubGlobal("React", React); vi.clearAllMocks(); sessionStorage.clear(); });
afterEach(() => { cleanup(); setClientProjectId(null); vi.unstubAllGlobals(); });

describe("calendar inside Autopilot", () => {
  it.each(["image", "video", "carousel"])("binds %s media to the current tab and fails closed without a project", (kind) => {
    const asset = { kind: kind === "video" ? "video" : "image", url: "/api/media/assets/41?projectId=7" };
    const media = kind === "carousel" ? { kind, items: [asset] } : asset;
    for (const project of [23, null]) {
      setClientProjectId(project);
      const view = render(<Harness media={media} returnItemId={pending.id} />);
      const element = within(screen.getByRole("dialog")).getByText("Полный текст публикации").parentElement!.querySelector("img,video");
      expect(element?.getAttribute("src")).toBe(`/api/media/assets/41?projectId=${project ?? 0}`);
      view.unmount();
    }
  });
  it("expands in place and selects only eligible posts, never already scheduled or blocked ones", () => {
    render(<Harness />);
    const expand = screen.getByRole("button", { name: "Расписание публикаций" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expand);
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Месяц" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Выбрать все готовые (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Добавить в основной календарь · 1" }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("checkbox", { name: "Выбрать пост: Пост в календаре" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Выбрать пост: Проверить факты" })).toBeNull();
  });
  it("opens the full post, contains keyboard focus, and restores focus when closed", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Открыть пост: Первый пост" }); trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Полный текст публикации")).toBeTruthy();
    const close = within(dialog).getByRole("button", { name: "Закрыть просмотр поста" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(add).not.toHaveBeenCalled();
  });
  it("lets a scheduled post open and edit the same record without another add action", () => {
    render(<Harness returnItemId="real-51" />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Добавить в основной календарь" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Редактировать" }));
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ postId: 51 }));
  });
  it("changes date/time from the post panel and preserves the selected calendar period on remount", async () => {
    const rendered = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Развернуть календарь" }));
    fireEvent.click(screen.getByRole("button", { name: "Месяц" }));
    fireEvent.click(screen.getByRole("button", { name: "Открыть пост: Первый пост" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Изменить дату и время" }));
    fireEvent.change(within(dialog).getByLabelText("Дата"), { target: { value: "2026-09-09" } });
    fireEvent.change(within(dialog).getByLabelText("Время, МСК"), { target: { value: "16:30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить время" }));
    await waitFor(() => expect(move).toHaveBeenCalledWith(pending, "2026-09-09", "16:30"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Закрыть просмотр поста" }));
    fireEvent.click(screen.getByRole("button", { name: "Следующий период" }));
    rendered.unmount(); render(<Harness />);
    expect(screen.getByRole("button", { name: "Месяц" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("октябрь 2026 г.")).toBeTruthy();
  });
});
