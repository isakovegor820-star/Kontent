import "server-only";

import { getPool } from "./db";
import {
  filterAndSortLibraryItems,
  type LibraryFilters,
  type LibraryRegistryItem,
} from "./library-filters";
import {
  explainLibraryScore,
  LIBRARY_FORMULA_VERSION,
  normalizeLibraryFormat,
  scoreLibraryCohorts,
  type LibraryScoredItem,
} from "./library-scoring.mjs";
import { resolveLibraryChannel } from "./library-server";

type SourcePostRow = {
  id: string;
  channel_id: string;
  channel_title: string | null;
  source_id: string;
  source_title: string | null;
  handle: string | null;
  tg_msg_id: string | null;
  text: string;
  views: number | string | null;
  reactions: number | string | null;
  posted_at: Date | string;
  media: string | null;
  saved: boolean;
  viewed_at: Date | string | null;
  rating: number | string | null;
};

type IdeaRow = {
  id: string;
  source_post_id: string | null;
  source_id: string | null;
  topic: string | null;
  hook: string | null;
  structure: string | null;
  why_it_worked: string | null;
  created_at: Date | string;
  source_title: string | null;
  handle: string | null;
  tg_msg_id: string | null;
  viewed_at: Date | string | null;
  rating: number | string | null;
};

type SavedRow = {
  id: string;
  source_post_id: string | null;
  source_title: string | null;
  source_url: string | null;
  text: string;
  created_at: Date | string;
  viewed_at: Date | string | null;
  rating: number | string | null;
};

function numeric(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function iso(value: Date | string | null | undefined) {
  const date = value instanceof Date ? value : new Date(value ?? "");
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function telegramUrl(handle: string | null, messageId: string | null) {
  const clean = handle?.replace(/^@/u, "");
  return clean && messageId ? `https://t.me/${clean}/${messageId}` : null;
}

function ideaText(row: IdeaRow) {
  return [row.topic, row.hook, row.structure, row.why_it_worked].filter(Boolean).join("\n\n");
}

function scoredFields(score: LibraryScoredItem | undefined) {
  return {
    views: numeric(score?.views),
    reactions: numeric(score?.reactions),
    lift: numeric(score?.lift),
    erBayes: numeric(score?.erBayes),
    velocity: numeric(score?.velocity),
    velocityZ: numeric(score?.velocityZ),
    freshness: numeric(score?.freshness),
    analyticsScore: numeric(score?.score),
    formulaVersion: score?.formulaVersion ?? LIBRARY_FORMULA_VERSION,
    dataQuality: score?.dataQuality ?? null,
    dataMaturity: score?.dataMaturity ?? null,
    isHit: score?.isHit ?? false,
    explanation: score ? explainLibraryScore(score) : "Недостаточно сопоставимых данных для аналитического Score.",
  } satisfies Partial<LibraryRegistryItem>;
}

export type LibraryRegistrySnapshot = {
  exportedAt: string;
  activeFilters: LibraryFilters;
  formulaVersion: string;
  channelId: number;
  channelTitle: string;
  items: LibraryRegistryItem[];
};

export async function buildLibraryRegistrySnapshot(
  userId: number,
  filters: LibraryFilters,
): Promise<LibraryRegistrySnapshot | null> {
  const channelId = await resolveLibraryChannel(userId, filters.channelId);
  if (!channelId) return null;
  const pool = getPool();
  const channel = await pool.query<{ title: string | null }>(
    `select title from channels where id = $1 and user_id = $2`,
    [channelId, userId],
  );
  const channelTitle = channel.rows[0]?.title || `Канал ${channelId}`;

  const sourceRows = (
    await pool.query<SourcePostRow>(
      `select p.id, c.channel_id, ch.title as channel_title, c.id as source_id,
              c.title as source_title, c.handle, p.tg_msg_id, p.text, p.views,
              p.reactions, p.posted_at, p.media,
              exists (
                select 1 from saved_posts saved
                 where saved.user_id = $1 and saved.channel_id = $2
                   and saved.source_post_id = p.id
              ) as saved,
              state.viewed_at, state.rating
         from competitor_posts p
         join competitors c on c.id = p.competitor_id
         join channels ch on ch.id = c.channel_id and ch.user_id = c.user_id
         left join library_item_states state
           on state.user_id = $1 and state.channel_id = $2
          and state.item_type = 'reference' and state.item_id = p.id
        where c.user_id = $1 and c.channel_id = $2
          and p.text is not null and length(p.text) > 0
          and p.posted_at is not null
          and p.posted_at >= now() - interval '365 days'
        order by p.posted_at desc
        limit 5000`,
      [userId, channelId],
    )
  ).rows;

  const scored = scoreLibraryCohorts(
    sourceRows.map((row) => ({
      ...row,
      channelId: row.channel_id,
      sourceId: row.source_id,
      postedAt: row.posted_at,
    })),
  );
  const scoreByPost = new Map(scored.map((item) => [String(item.id), item]));
  const references: LibraryRegistryItem[] = sourceRows.map((row) => {
    const score = scoreByPost.get(String(row.id));
    return {
      id: `reference:${row.id}`,
      kind: "reference",
      channelId,
      channelTitle,
      sourceId: String(row.source_id),
      sourceTitle: row.source_title || row.handle || "Открытый источник",
      sourceUrl: telegramUrl(row.handle, row.tg_msg_id),
      sourceData: "public_telegram",
      text: row.text,
      postedAt: iso(row.posted_at),
      format: normalizeLibraryFormat(row.media),
      saved: Boolean(row.saved),
      viewedAt: row.viewed_at ? iso(row.viewed_at) : null,
      userRating: numeric(row.rating),
      ...scoredFields(score),
    };
  });

  const ideas = (
    await pool.query<IdeaRow>(
      `select idea.id, idea.source_post_id, competitor.id as source_id,
              idea.topic, idea.hook, idea.structure, idea.why_it_worked,
              idea.created_at, competitor.title as source_title, competitor.handle,
              post.tg_msg_id, state.viewed_at, state.rating
         from content_ideas idea
         join competitors competitor on competitor.id = idea.competitor_id
         left join competitor_posts post on post.id = idea.source_post_id
         left join library_item_states state
           on state.user_id = $1 and state.channel_id = $2
          and state.item_type = 'idea' and state.item_id = idea.id
        where idea.user_id = $1 and competitor.channel_id = $2
          and idea.status = 'new'
        order by idea.created_at desc
        limit 1000`,
      [userId, channelId],
    )
  ).rows.map((row): LibraryRegistryItem => {
    const score = row.source_post_id ? scoreByPost.get(String(row.source_post_id)) : undefined;
    return {
      id: `idea:${row.id}`,
      kind: "idea",
      channelId,
      channelTitle,
      sourceId: row.source_id ? String(row.source_id) : null,
      sourceTitle: row.source_title || row.handle || "Идея Авроры",
      sourceUrl: telegramUrl(row.handle, row.tg_msg_id),
      sourceData: "aurora_idea_from_public_source",
      text: ideaText(row),
      postedAt: iso(row.created_at),
      format: score?.format ?? "text",
      saved: false,
      viewedAt: row.viewed_at ? iso(row.viewed_at) : null,
      userRating: numeric(row.rating),
      ...scoredFields(score),
    };
  });

  const saved = (
    await pool.query<SavedRow>(
      `select saved.id, saved.source_post_id, saved.source_title, saved.source_url,
              saved.text, saved.created_at, state.viewed_at, state.rating
         from saved_posts saved
         left join library_item_states state
           on state.user_id = $1 and state.channel_id = $2
          and state.item_type = 'saved' and state.item_id = saved.id
        where saved.user_id = $1 and saved.channel_id = $2
        order by saved.created_at desc
        limit 1000`,
      [userId, channelId],
    )
  ).rows.map((row): LibraryRegistryItem => {
    const score = row.source_post_id ? scoreByPost.get(String(row.source_post_id)) : undefined;
    return {
      id: `saved:${row.id}`,
      kind: "saved",
      channelId,
      channelTitle,
      sourceId: row.source_post_id ? String(row.source_post_id) : null,
      sourceTitle: row.source_title || "Сохранённый материал",
      sourceUrl: row.source_url,
      sourceData: row.source_post_id ? "saved_public_reference" : "user_library",
      text: row.text,
      postedAt: iso(row.created_at),
      format: score?.format ?? "text",
      saved: true,
      viewedAt: row.viewed_at ? iso(row.viewed_at) : null,
      userRating: numeric(row.rating),
      ...scoredFields(score),
    };
  });

  return {
    exportedAt: new Date().toISOString(),
    activeFilters: { ...filters, channelId },
    formulaVersion: LIBRARY_FORMULA_VERSION,
    channelId,
    channelTitle,
    items: filterAndSortLibraryItems([...references, ...ideas, ...saved], filters),
  };
}

export async function assertLibraryItemOwnership(
  userId: number,
  channelId: number,
  itemType: "reference" | "idea" | "saved",
  itemId: number,
) {
  const pool = getPool();
  if (itemType === "reference") {
    const row = await pool.query(
      `select 1 from competitor_posts post
        join competitors competitor on competitor.id = post.competitor_id
       where post.id = $1 and competitor.user_id = $2 and competitor.channel_id = $3`,
      [itemId, userId, channelId],
    );
    return Boolean(row.rowCount);
  }
  if (itemType === "idea") {
    const row = await pool.query(
      `select 1 from content_ideas idea
        join competitors competitor on competitor.id = idea.competitor_id
       where idea.id = $1 and idea.user_id = $2 and competitor.channel_id = $3`,
      [itemId, userId, channelId],
    );
    return Boolean(row.rowCount);
  }
  const row = await pool.query(
    `select 1 from saved_posts where id = $1 and user_id = $2 and channel_id = $3`,
    [itemId, userId, channelId],
  );
  return Boolean(row.rowCount);
}
