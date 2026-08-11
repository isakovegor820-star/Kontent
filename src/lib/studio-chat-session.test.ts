import { describe, expect, it } from "vitest";
import {
  mergeStudioChatSessions,
  parseStudioChatSession,
  serializeStudioChatSession,
  stopStudioStreamingMessages,
  studioChatStorageKey,
  type StudioChatSession,
} from "./studio-chat-session";

const session: StudioChatSession = {
  messages: [
    { id: "u1", role: "user", text: "Напиши пост" },
    { id: "a1", role: "ai", text: "Готовый пост", postable: true },
  ],
  draft: "Уточнение",
  workspaceMode: "studio",
  generations: [["a1", {
    cmd: "write",
    input: "Напиши пост",
    variant: 0,
    history: [],
    requestKey: "studio-request-123",
    referenceText: "Чужой пост используется только как форма",
    referenceSource: "Конкурент",
    sourceRef: { kind: "competitor", id: "competitor:71", label: "Конкурент" },
    referenceDraftId: 71,
    referenceDraftVersion: 3,
    referenceIntent: "create",
    channelId: 42,
  }]],
};

describe("studio chat session", () => {
  it("восстанавливает сообщения, черновик, режим и данные для повторной генерации", () => {
    const restored = parseStudioChatSession(serializeStudioChatSession(17, session), 17);
    expect(restored).toMatchObject(session);
  });

  it("не отдаёт историю другому аккаунту", () => {
    const raw = serializeStudioChatSession(17, session);
    expect(parseStudioChatSession(raw, 18)).toBeNull();
    expect(studioChatStorageKey(17)).toBe("aurora:studio-chat:v2:user-17");
    expect(studioChatStorageKey(17)).not.toBe(studioChatStorageKey(18));
  });

  it("после перезагрузки не оставляет вечное состояние генерации", () => {
    const raw = serializeStudioChatSession(17, {
      ...session,
      messages: [
        session.messages[0],
        { id: "a1", role: "ai", text: "Разбираю задачу…", streaming: true, postable: false },
      ],
    });
    const restored = parseStudioChatSession(raw, 17);
    expect(restored?.messages[1]).toMatchObject({
      streaming: false,
      postable: false,
      text: "Генерация прервалась. Запусти ещё один вариант — история диалога сохранена.",
    });
  });

  it("сохраняет частичный текст и тот же ключ для безопасного повтора после перезагрузки", () => {
    const raw = serializeStudioChatSession(17, {
      ...session,
      messages: [
        session.messages[0],
        { id: "a1", role: "ai", text: "Уже полученная часть ответа", streaming: true, postable: false },
      ],
    });
    const restored = parseStudioChatSession(raw, 17);

    expect(restored?.messages[1]).toMatchObject({
      text: "Уже полученная часть ответа",
      interrupted: true,
      retryable: true,
      postable: false,
    });
    expect(restored?.generations[0]?.[1]).toMatchObject({
      requestKey: "studio-request-123",
      channelId: 42,
      sourceRef: { kind: "competitor", id: "competitor:71" },
      referenceDraftId: 71,
      referenceDraftVersion: 3,
      referenceIntent: "create",
    });
  });

  it("по команде стоп сразу завершает поток, сохраняет черновик и не показывает ошибку", () => {
    const stopped = stopStudioStreamingMessages([
      { id: "u1", role: "user", text: "Напиши пост" },
      {
        id: "a1",
        role: "ai",
        text: "Уже полученная часть ответа",
        streaming: true,
        progressLabel: "Собираю первый черновик…",
        postable: true,
        reviewable: true,
        errorMessage: "Старая ошибка",
      },
    ]);

    expect(stopped[0]).toEqual({ id: "u1", role: "user", text: "Напиши пост" });
    expect(stopped[1]).toMatchObject({
      text: "Уже полученная часть ответа",
      streaming: false,
      postable: false,
      reviewable: false,
      interrupted: true,
      retryable: true,
      errorMessage: undefined,
      statusMessage: "Генерация остановлена. Черновик сохранён — его можно скопировать или повторить запрос.",
    });
    expect(stopped[1]?.progressLabel).toBeUndefined();
  });

  it("не сохраняет служебную заглушку как текст остановленного черновика", () => {
    const [stopped] = stopStudioStreamingMessages([
      { id: "a1", role: "ai", text: "Разбираю задачу…", streaming: true },
    ]);

    expect(stopped?.text).toBe("");
    expect(stopped?.retryable).toBe(true);
  });

  it("безопасно игнорирует повреждённые данные", () => {
    expect(parseStudioChatSession("{bad json", 17)).toBeNull();
    expect(parseStudioChatSession(JSON.stringify({ version: 1 }), 17)).toBeNull();
  });

  it("isolates two social accounts even when both display the same provider label", () => {
    const telegram = serializeStudioChatSession(101, session);
    expect(parseStudioChatSession(telegram, 202)).toBeNull();
    expect(studioChatStorageKey(101)).not.toBe(studioChatStorageKey(202));
  });

  it("объединяет серверную историю с сообщениями активной вкладки без дублей", () => {
    const merged = mergeStudioChatSessions(
      session,
      {
        ...session,
        messages: [
          { id: "a1", role: "ai", text: "Исправленный готовый пост", postable: true },
          { id: "u2", role: "user", text: "Добавь финал" },
        ],
        draft: "Новый черновик",
      },
    );

    expect(merged.messages).toEqual([
      { id: "u1", role: "user", text: "Напиши пост" },
      { id: "a1", role: "ai", text: "Исправленный готовый пост", postable: true },
      { id: "u2", role: "user", text: "Добавь финал" },
    ]);
    expect(merged.draft).toBe("Новый черновик");
    expect(merged.generations).toHaveLength(1);
  });

  it("не затирает серверный черновик пустым снимком после внезапной перезагрузки", () => {
    const merged = mergeStudioChatSessions(
      { ...session, draft: "Набранный текст" },
      { ...session, draft: "" },
    );

    expect(merged.draft).toBe("Набранный текст");
  });
});
