import type { PoolClient } from "pg";
export function persistAutopilotEditorPayload(db: Pick<PoolClient, "query">, postId: number, item: { draft: string; editorVersion?: number; formatting?: unknown; media?: unknown }): Promise<void>;
export function autopilotEditorPostHash(post: { text: string; media?: unknown; scheduled_at: string | Date; schedule_revision: number | string }): string;

export function autopilotEditorContent(text: string, formatting?: import("./rich-text.mjs").RichTextEntity[]): { text: string; formatting: import("./rich-text.mjs").RichTextEntity[] };
