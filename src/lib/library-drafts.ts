import "server-only";

import type { DraftCreateInput } from "./draft-types";
import { buildLibraryDraftContext } from "./library";

type Queryable = {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
};

export class LibraryDraftError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "LibraryDraftError";
  }
}

export function parseLibraryItemKey(value: unknown) {
  const match = String(value || "").trim().match(/^(reference|idea|saved):(\d+)$/u);
  const id = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(id) || id <= 0) throw new LibraryDraftError("bad_library_item");
  return { kind: match[1] as "reference" | "idea" | "saved", id };
}

export async function buildServerLibraryDraftContext(input: {
  db: Queryable;
  userId: number;
  projectId: number;
  channelId: number;
  itemKey: string;
  clientKey: string;
}): Promise<DraftCreateInput> {
  const { db, userId, projectId, channelId, clientKey } = input;
  const item = parseLibraryItemKey(input.itemKey);
  const channel = (await db.query<{ id: string }>(
    `select id from channels
      where id = $1 and user_id = $2 and project_id = $3
        and is_active = true and status = 'active'`,
    [channelId, userId, projectId],
  )).rows[0];
  if (!channel) throw new LibraryDraftError("library_channel_unavailable");

  if (item.kind === "reference") {
    const row = (await db.query<{
      id: string; text: string; source_id: string; source_title: string | null;
      handle: string | null; tg_msg_id: string | null;
    }>(
      `select post.id, post.text, competitor.id as source_id,
              competitor.title as source_title, competitor.handle, post.tg_msg_id
         from competitor_posts post
         join competitors competitor on competitor.id = post.competitor_id
         join channels channel on channel.id = competitor.channel_id
        where post.id = $1 and competitor.user_id = $2
          and competitor.channel_id = $3 and channel.project_id = $4
          and post.text is not null and length(trim(post.text)) > 0`,
      [item.id, userId, channelId, projectId],
    )).rows[0];
    if (!row) throw new LibraryDraftError("library_item_not_found");
    const label = row.source_title || (row.handle ? `@${row.handle}` : "Открытый источник");
    const handle = row.handle?.replace(/^@/u, "");
    return buildLibraryDraftContext({
      text: row.text,
      channelId,
      clientKey,
      material: {
        kind: "reference",
        id: row.id,
        sourceLabel: label,
        provenanceLabel: label,
        sourceId: row.source_id,
        sourceUrl: handle && row.tg_msg_id ? `https://t.me/${handle}/${row.tg_msg_id}` : null,
      },
    });
  }

  if (item.kind === "idea") {
    const row = (await db.query<{
      id: string; topic: string | null; hook: string | null; structure: string | null;
      why_it_worked: string | null; source_id: string | null; source_title: string | null;
      handle: string | null; tg_msg_id: string | null;
    }>(
      `select idea.id, idea.topic, idea.hook, idea.structure, idea.why_it_worked,
              competitor.id as source_id, competitor.title as source_title,
              competitor.handle, post.tg_msg_id
         from content_ideas idea
         join competitors competitor on competitor.id = idea.competitor_id
         join channels channel on channel.id = competitor.channel_id
         left join competitor_posts post on post.id = idea.source_post_id
        where idea.id = $1 and idea.user_id = $2
          and competitor.channel_id = $3 and channel.project_id = $4
          and idea.status = 'new' and idea.ai_status = 'ready'`,
      [item.id, userId, channelId, projectId],
    )).rows[0];
    const text = [row?.topic, row?.hook, row?.structure, row?.why_it_worked].filter(Boolean).join("\n\n").trim();
    if (!row || !text || !row.topic?.trim()) throw new LibraryDraftError("library_item_not_found");
    const label = row.source_title || (row.handle ? `@${row.handle}` : "Идея Авроры");
    const handle = row.handle?.replace(/^@/u, "");
    return buildLibraryDraftContext({
      text,
      channelId,
      clientKey,
      material: {
        kind: "idea",
        id: row.id,
        sourceLabel: "Идея Авроры",
        provenanceLabel: label,
        sourceId: row.source_id,
        sourceUrl: handle && row.tg_msg_id ? `https://t.me/${handle}/${row.tg_msg_id}` : null,
        topic: row.topic,
        hook: row.hook,
        structure: row.structure,
        whyItWorked: row.why_it_worked,
      },
    });
  }

  const row = (await db.query<{ id: string; text: string }>(
    `select saved.id, saved.text
       from saved_posts saved
       join channels channel on channel.id = saved.channel_id
      where saved.id = $1 and saved.user_id = $2 and saved.channel_id = $3
        and channel.project_id = $4
        and saved.text is not null and length(trim(saved.text)) > 0`,
    [item.id, userId, channelId, projectId],
  )).rows[0];
  if (!row) throw new LibraryDraftError("library_item_not_found");
  // Снимок сохранённого материала уже принадлежит пользователю и извлечён сервером.
  // Поэтому удалённый оригинал не должен ломать открытие редактора.
  return buildLibraryDraftContext({ text: row.text, channelId, clientKey });
}
