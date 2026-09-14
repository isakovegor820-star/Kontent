// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudienceAssistantPanel } from "./audience-assistant-panel";

const inquiry = {
  id: 41, projectId: 7, sourceType: "comment", sourceLabel: "Telegram",
  incomingText: "А сколько это стоит?", suggestedReply: "Уточним стоимость.",
  status: "reply_ready", version: 1, canSendViaTelegram: true, canDeliverReply: true,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("audience draft controls", () => {
  it("deletes an unsent draft and refreshes the ready counter", async () => {
    let deleted = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/41/draft")) {
        expect(init?.method).toBe("DELETE");
        expect(JSON.parse(String(init?.body))).toEqual({ expectedVersion: 1 });
        deleted = true;
        return Response.json({ inquiry: { ...inquiry, suggestedReply: null, status: "pending", version: 2 } });
      }
      return Response.json({
        inquiries: [{ ...inquiry, ...(deleted ? { suggestedReply: null, status: "pending", version: 2 } : {}) }],
        stats: { waiting: deleted ? 1 : 0, ready: deleted ? 0 : 1, answered: 0, dismissed: 0, highRisk: 0 },
        capabilities: { canEdit: true, canSend: true },
      });
    });
    vi.stubGlobal("fetch", fetch);
    render(<AudienceAssistantPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Черновики · 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Удалить черновик" }));
    await screen.findByText("Черновик удалён. Исходное обращение сохранено в разделе «Нужен ответ».");
    await waitFor(() => expect(screen.queryByDisplayValue("Уточним стоимость.")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Нужен ответ · 1" }));
    expect(screen.getByText("А сколько это стоит?")).toBeTruthy();
  });
  it("does not offer deletion while Telegram is sending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      inquiries: [{ ...inquiry, status: "approved" }],
      stats: { waiting: 0, ready: 1, answered: 0, dismissed: 0, highRisk: 0 },
      capabilities: { canEdit: true, canSend: true },
    })));
    render(<AudienceAssistantPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Черновики · 1" }));
    expect(screen.queryByRole("button", { name: "Удалить черновик" })).toBeNull();
  });
});
