import { describe, expect, it } from "vitest";

import { buildPublicationBlockSnapshot, type ReusableBlock } from "./publication-blocks";

const blocks: ReusableBlock[] = [
  { id: 1, projectId: 7, kind: "author_signature", name: "Подпись Анны", text: "Анна Петрова, адвокат", version: 3, enabled: true },
  { id: 2, projectId: 7, kind: "disclaimer", name: "Оговорка", text: "Материал носит информационный характер.", version: 2, enabled: true },
  { id: 3, projectId: 7, kind: "first_comment", name: "Комментарий", text: "Скачать памятку: https://example.ru", version: 8, enabled: true },
];

describe("publication reusable block snapshots", () => {
  it("freezes exact block versions in visible preview order", () => {
    const result = buildPublicationBlockSnapshot({
      projectId: 7,
      body: "Что изменилось в договорной работе",
      selectedBlockIds: [2, 1, 3],
      blocks,
      providerSupportsFirstComment: true,
      firstCommentFallback: "skip",
    });
    expect(result.renderedText).toBe([
      "Что изменилось в договорной работе",
      "Материал носит информационный характер.",
      "Анна Петрова, адвокат",
    ].join("\n\n"));
    expect(result.blocks.map((block) => [block.id, block.version])).toEqual([[2, 2], [1, 3], [3, 8]]);
    expect(result.firstComment).toMatchObject({ delivery: "provider_comment", blockVersion: 8 });
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses the chosen unsupported-provider fallback before publication", () => {
    const appended = buildPublicationBlockSnapshot({
      projectId: 7,
      body: "Пост",
      selectedBlockIds: [3],
      blocks,
      providerSupportsFirstComment: false,
      firstCommentFallback: "append_to_post",
    });
    expect(appended.renderedText).toContain("Скачать памятку");
    expect(appended.firstComment?.delivery).toBe("appended");

    const skipped = buildPublicationBlockSnapshot({
      projectId: 7,
      body: "Пост",
      selectedBlockIds: [3],
      blocks,
      providerSupportsFirstComment: false,
      firstCommentFallback: "skip",
    });
    expect(skipped.renderedText).toBe("Пост");
    expect(skipped.firstComment?.delivery).toBe("skipped");
  });

  it("rejects cross-project, disabled, duplicate and ambiguous selections", () => {
    expect(() => buildPublicationBlockSnapshot({
      projectId: 8,
      body: "Пост",
      selectedBlockIds: [1],
      blocks,
      providerSupportsFirstComment: true,
      firstCommentFallback: "skip",
    })).toThrow("block_unavailable");
    expect(() => buildPublicationBlockSnapshot({
      projectId: 7,
      body: "Пост",
      selectedBlockIds: [1, 1],
      blocks,
      providerSupportsFirstComment: true,
      firstCommentFallback: "skip",
    })).toThrow("duplicate_block_selection");
    expect(() => buildPublicationBlockSnapshot({
      projectId: 7,
      body: "Пост",
      selectedBlockIds: [3, 4],
      blocks: [...blocks, { ...blocks[2], id: 4 }],
      providerSupportsFirstComment: true,
      firstCommentFallback: "skip",
    })).toThrow("multiple_first_comments");
  });
});
