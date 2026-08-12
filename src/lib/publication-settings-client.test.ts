import { describe, expect, it } from "vitest";

import {
  applyPublicationSettingsPreview,
  buildPublicationSettingsPreview,
  parsePublicationBlocksResponse,
  parsePublicationPreferencesResponse,
  publicationSettingCapability,
} from "./publication-settings-client";

const blocks = [
  { id: 1, kind: "author_signature", name: "Подпись", text: "Анна, юрист", version: 1, enabled: true, updatedAt: "2026-08-12T00:00:00.000Z" },
  { id: 2, kind: "first_comment", name: "Комментарий", text: "Запись на консультацию", version: 2, enabled: true, updatedAt: "2026-08-12T00:00:00.000Z" },
] as const;

it("parses only complete server-owned blocks and preferences", () => {
  expect(parsePublicationBlocksResponse({ ok: true, blocks })).toHaveLength(2);
  expect(parsePublicationPreferencesResponse({
    ok: true,
    preferences: {
      draftId: 8,
      selectedBlockIds: [1, 2],
      firstCommentFallback: "skip",
      commentsMode: "provider_default",
      pinAfterPublish: false,
      reviewAt: null,
      reviewResponsibleUserId: null,
      version: 1,
      draftVersion: 4,
    },
  })).toMatchObject({ draftId: 8, selectedBlockIds: [1, 2], draftVersion: 4 });
});

describe("exact publication settings preview", () => {
  const preferences = {
    draftId: 8,
    selectedBlockIds: [1, 2],
    firstCommentFallback: "append_to_post" as const,
    commentsMode: "provider_default" as const,
    pinAfterPublish: false,
    reviewAt: null,
    reviewResponsibleUserId: null,
    version: 1,
  };
  const preview = buildPublicationSettingsPreview([...blocks], preferences);

  it("keeps Telegram first comment separate from the main text", () => {
    expect(applyPublicationSettingsPreview({
      body: "Основной текст",
      firstCommentText: "Короткая ссылка",
      providerId: "tg",
      preview,
    })).toEqual({
      mainText: "Основной текст\n\nАнна, юрист",
      firstCommentText: "Запись на консультацию\n\nКороткая ссылка",
      supportsFirstComment: true,
    });
  });

  it("applies the selected fallback for an unsupported destination", () => {
    expect(applyPublicationSettingsPreview({
      body: "Основной текст",
      firstCommentText: "Короткая ссылка",
      providerId: "youtube",
      preview,
    })).toMatchObject({
      mainText: "Основной текст\n\nАнна, юрист\n\nЗапись на консультацию\n\nКороткая ссылка",
      firstCommentText: null,
      supportsFirstComment: false,
    });
  });
});

it("reports partial capabilities instead of silently ignoring unsupported providers", () => {
  expect(publicationSettingCapability(["tg", "vk"], "pin")).toEqual({
    supported: ["tg"],
    unsupported: ["vk"],
    available: true,
    partial: true,
  });
});
