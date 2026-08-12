import { describe, expect, it } from "vitest";

import {
  parseApprovedPublicationPreferences,
  renderPublicationForDestination,
} from "./publication-destination-render";

const approved = {
  version: 2,
  selectedBlocks: [
    { id: 1, kind: "author_signature", name: "Подпись", text: "Адвокат Анна Орлова", version: 3 },
    { id: 2, kind: "first_comment", name: "Комментарий", text: "Список документов", version: 4 },
  ],
  firstCommentFallback: "append_to_post",
  commentsMode: "disabled",
  pinAfterPublish: true,
  reviewAt: "2026-09-11T10:00:00.000Z",
  reviewResponsibleUserId: 8,
};

describe("approved publication destination rendering", () => {
  it("parses only immutable block values stored in the approved revision", () => {
    expect(parseApprovedPublicationPreferences(approved, 7)).toMatchObject({
      version: 2,
      selectedBlocks: [
        expect.objectContaining({ id: 1, projectId: 7, text: "Адвокат Анна Орлова", version: 3 }),
        expect.objectContaining({ id: 2, kind: "first_comment", version: 4 }),
      ],
      reviewResponsibleUserId: 8,
    });
  });

  it("combines a reusable Telegram first comment with a tracked link", () => {
    const rendered = renderPublicationForDestination({
      projectId: 7,
      body: "Основной текст",
      providerId: "tg",
      preferences: parseApprovedPublicationPreferences(approved, 7),
      tracking: {
        shortLinkId: 9,
        shortUrlPath: "/r/abcdefghijklmnopqrst",
        destination: "https://example.ru/consultation",
        utmValues: {},
        placement: "first_comment",
      },
      appUrl: "https://aurora.example",
    });
    expect(rendered.mainText).toBe("Основной текст\n\nАдвокат Анна Орлова");
    expect(rendered.firstCommentText).toBe(
      "Список документов\n\nПодробнее: https://aurora.example/r/abcdefghijklmnopqrst",
    );
    expect(rendered.blockSnapshot.firstComment).toMatchObject({
      delivery: "provider_comment",
      source: "block_and_tracking",
      blockVersion: 4,
    });
  });

  it("applies the chosen fallback before creating an unsupported provider snapshot", () => {
    const rendered = renderPublicationForDestination({
      projectId: 7,
      body: "Основной текст",
      providerId: "tenchat",
      preferences: parseApprovedPublicationPreferences(approved, 7),
      tracking: null,
      appUrl: "https://aurora.example",
    });
    expect(rendered.mainText).toBe("Основной текст\n\nАдвокат Анна Орлова\n\nСписок документов");
    expect(rendered.firstCommentText).toBeNull();
    expect(rendered.blockSnapshot.firstComment).toMatchObject({ delivery: "appended" });
  });

  it("rejects duplicated or malformed approved blocks", () => {
    expect(() => parseApprovedPublicationPreferences({
      ...approved,
      selectedBlocks: [approved.selectedBlocks[0], approved.selectedBlocks[0]],
    }, 7)).toThrow("publication_preferences_invalid");
  });
});
