import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { serializeStudioChatSession, type StudioChatSession } from "./studio-chat-session";
import {
  parseStudioChatSaveInput,
  saveStudioChatSessionForUser,
  StudioChatPersistenceError,
} from "./studio-chat-persistence";

const session: StudioChatSession = {
  messages: [
    { id: "u1", role: "user", text: "Напиши пост" },
    { id: "a1", role: "ai", text: "Готовый пост", postable: true },
  ],
  draft: "",
  workspaceMode: "chat",
  generations: [],
};

describe("studio chat persistence", () => {
  beforeEach(() => vi.clearAllMocks());

  it("принимает только нормализованный снимок того же пользователя", () => {
    const payload = JSON.parse(serializeStudioChatSession(7, session));
    const parsed = parseStudioChatSaveInput({ expectedRevision: 3, session: payload }, 7);

    expect(parsed.expectedRevision).toBe(3);
    expect(parsed.session.messages).toHaveLength(2);
  });

  it("не позволяет записать историю другого аккаунта", () => {
    const payload = JSON.parse(serializeStudioChatSession(7, session));
    expect(() => parseStudioChatSaveInput({ expectedRevision: 0, session: payload }, 8))
      .toThrowError(new StudioChatPersistenceError("invalid_session"));
  });

  it("отклоняет некорректную revision", () => {
    const payload = JSON.parse(serializeStudioChatSession(7, session));
    expect(() => parseStudioChatSaveInput({ expectedRevision: -1, session: payload }, 7))
      .toThrowError(new StudioChatPersistenceError("invalid_revision"));
  });

  it("обновляет существующий снимок по revision, а не только создаёт первый", async () => {
    const payload = JSON.parse(serializeStudioChatSession(7, session));
    mocks.query.mockResolvedValue({
      rows: [{ payload, revision: "4", updated_at: "2026-08-10T10:00:00.000Z" }],
    });

    const result = await saveStudioChatSessionForUser(7, {
      expectedRevision: 3,
      payload,
      session,
    });

    expect(result).toMatchObject({ saved: true, session: { revision: 4 } });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("with updated as"),
      [7, JSON.stringify(payload), 3],
    );
  });
});
