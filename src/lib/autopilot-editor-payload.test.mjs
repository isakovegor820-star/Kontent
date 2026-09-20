import { describe, expect, it, vi } from "vitest";
import { autopilotEditorContent, autopilotEditorPostHash, persistAutopilotEditorPayload } from "./autopilot-editor-payload.mjs";

describe("Autopilot editor publication payload", () => {
  it("preserves generated bold and spoiler formatting, including UTF-16 offsets", () => {
    expect(autopilotEditorContent("Привет **мир 🌍** и ||секрет||")).toEqual({ text: "Привет мир 🌍 и секрет", formatting: [
      { type: "bold", offset: 7, length: 6 }, { type: "spoiler", offset: 16, length: 6 },
    ] });
    const explicit = { text: "**буквально**", formatting: [] };
    expect(autopilotEditorContent(explicit.text, explicit.formatting)).toEqual(explicit);
  });
  it("persists exact rich text and media parts without exposing raw HTML from user text", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await persistAutopilotEditorPayload({ query }, 45, { editorVersion: 3, draft: "Текст <script>", media: { kind: "image", assetId: 7 }, formatting: [{ type: "bold", offset: 0, length: 5 }] });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([45, 0, "media_caption", "<b>Текст</b> &lt;script&gt;", expect.stringMatching(/^[a-f0-9]{64}$/u), 14]);
  });
  it("fences date, text, and media changes to the existing scheduled post", () => {
    const post = { text: "Текст", media: null, scheduled_at: "2026-09-15T12:00:00Z", schedule_revision: "1" };
    const hash = autopilotEditorPostHash(post);
    expect(autopilotEditorPostHash({ ...post, schedule_revision: 1, scheduled_at: new Date(post.scheduled_at) })).toBe(hash);
    for (const change of [{ text: "Правки" }, { media: { assetId: 5 } }, { schedule_revision: "2" }]) expect(autopilotEditorPostHash({ ...post, ...change })).not.toBe(hash);
  });
});
