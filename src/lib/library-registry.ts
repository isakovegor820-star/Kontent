import "server-only";

import { getPool } from "./db";
import {
  filterAndSortLibraryItems,
  type LibraryFilters,
  type LibraryMaturity,
  type LibraryQuality,
  type LibraryRegistryDiagnostics,
  type LibraryRegistryItem,
} from "./library-filters";
import {
  explainLibraryScore,
  LIBRARY_FORMULA_VERSION,
  normalizeLibraryFormat,
} from "./library-scoring.mjs";
import { configuredServiceEngine, resolveAiEngineRuntime } from "./ai-engine-policy.mjs";
import { resolveLibraryChannel } from "./library-server";
import { topicFromSourceText } from "./reference-adaptation";

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
  is_hit: boolean;
  analytics_lift: number | string | null;
  analytics_er_bayes: number | string | null;
  analytics_velocity: number | string | null;
  analytics_velocity_z: number | string | null;
  analytics_freshness: number | string | null;
  analytics_score: number | string | null;
  analytics_formula_version: string | null;
  analytics_quality: string | null;
  analytics_maturity: string | null;
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
  source_text: string | null;
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

type DiagnosticsRow = {
  competitor_count: number | string;
  source_post_count: number | string;
  pending_idea_count: number | string;
  ai_engine: string | null;
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

function quality(value: string | null | undefined): LibraryQuality | null {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function maturity(value: string | null | undefined): LibraryMaturity | null {
  return value === "collecting" || value === "mature" ? value : null;
}

/**
 * Analytics are calculated and versioned by the reconnaissance worker. Reading those
 * persisted values keeps search/filter requests cheap and guarantees that the card,
 * hit flag and export all describe the same calculation.
 */
function persistedScoredFields(row: SourcePostRow | undefined) {
  const score = {
    score: numeric(row?.analytics_score),
    lift: numeric(row?.analytics_lift),
    erBayes: numeric(row?.analytics_er_bayes),
    velocity: numeric(row?.analytics_velocity),
    velocityZ: numeric(row?.analytics_velocity_z),
    freshness: numeric(row?.analytics_freshness),
    formulaVersion: row?.analytics_formula_version || LIBRARY_FORMULA_VERSION,
    format: normalizeLibraryFormat(row?.media),
    missingMetrics: [],
  };
  return {
    views: numeric(row?.views),
    reactions: numeric(row?.reactions),
    lift: score.lift,
    erBayes: score.erBayes,
    velocity: score.velocity,
    velocityZ: score.velocityZ,
    freshness: score.freshness,
    analyticsScore: score.score,
    formulaVersion: score.formulaVersion,
    dataQuality: quality(row?.analytics_quality),
    dataMaturity: maturity(row?.analytics_maturity),
    isHit: Boolean(row?.is_hit),
    explanation: row ? explainLibraryScore(score) : "Недостаточно сопоставимых данных для аналитической оценки.",
  } satisfies Partial<LibraryRegistryItem>;
}

export type LibraryRegistrySnapshot = {
  exportedAt: string;
  activeFilters: LibraryFilters;
  formulaVersion: string;
  channelId: number;
  channelTitle: string;
  diagnostics: LibraryRegistryDiagnostics;
  items: LibraryRegistryItem[];
};

export async function buildLibraryRegistrySnapshot(
  userId: number,
  filters: LibraryFilters,
): Promise<LibraryRegistrySnapshot | null> {
  const channelId = await resolveLibraryChannel(userId, filters.channelId);
  if (!channelId) return null;
  const pool = getPool();
  const [channelResult, sourceResult, ideasResult, savedResult, diagnosticsResult] = await Promise.all([
    pool.query<{ title: string | null }>(
      `select title from channels where id = $1 and user_id = $2`,
      [channelId, userId],
    ),
    pool.query<SourcePostRow>(
      `select p.id, c.channel_id, ch.title as channel_title, c.id as source_id,
              c.title as source_title, c.handle, p.tg_msg_id, p.text, p.views,
              p.reactions, p.posted_at, p.media, p.is_hit,
              p.analytics_lift, p.analytics_er_bayes, p.analytics_velocity,
              p.analytics_velocity_z, p.analytics_freshness, p.analytics_score,
              p.analytics_formula_version, p.analytics_quality, p.analytics_maturity,
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
    ),
    pool.query<IdeaRow>(
      `select idea.id, idea.source_post_id, competitor.id as source_id,
              idea.topic, idea.hook, idea.structure, idea.why_it_worked,
              idea.created_at, competitor.title as source_title, competitor.handle,
              post.tg_msg_id, post.text as source_text, state.viewed_at, state.rating
         from content_ideas idea
         join competitors competitor on competitor.id = idea.competitor_id
         left join competitor_posts post on post.id = idea.source_post_id
         left join library_item_states state
           on state.user_id = $1 and state.channel_id = $2
          and state.item_type = 'idea' and state.item_id = idea.id
        where idea.user_id = $1 and competitor.channel_id = $2
          and idea.status = 'new' and idea.ai_status = 'ready'
        order by idea.created_at desc
        limit 1000`,
      [userId, channelId],
    ),
    pool.query<SavedRow>(
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
    ),
    pool.query<DiagnosticsRow>(
      `select
          (select count(*) from competitors
            where user_id = $1 and channel_id = $2 and is_active = true) as competitor_count,
          (select count(*) from competitor_posts post
             join competitors competitor on competitor.id = post.competitor_id
            where competitor.user_id = $1 and competitor.channel_id = $2) as source_post_count,
          (select count(*) from content_ideas idea
             join competitors competitor on competitor.id = idea.competitor_id
            where idea.user_id = $1 and competitor.channel_id = $2
              and idea.status = 'new' and idea.ai_status = 'pending') as pending_idea_count,
          (select ai_engine from users where id = $1) as ai_engine`,
      [userId, channelId],
    ),
  ]);
  const channelTitle = channelResult.rows[0]?.title || `Канал ${channelId}`;
  const sourceRows = sourceResult.rows;
  const sourceByPost = new Map(sourceRows.map((item) => [String(item.id), item]));
  const references: LibraryRegistryItem[] = sourceRows.map((row) => {
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
      ...persistedScoredFields(row),
    };
  });

  const ideas = ideasResult.rows.map((row): LibraryRegistryItem => {
    const source = row.source_post_id ? sourceByPost.get(String(row.source_post_id)) : undefined;
    const topic = row.topic?.trim() || topicFromSourceText(row.source_text);
    return {
      id: `idea:${row.id}`,
      kind: "idea",
      channelId,
      channelTitle,
      sourceId: row.source_id ? String(row.source_id) : null,
      sourceTitle: row.source_title || row.handle || "Идея Авроры",
      sourceUrl: telegramUrl(row.handle, row.tg_msg_id),
      sourceData: "aurora_idea_from_public_source",
      text: [topic, row.hook, row.structure, row.why_it_worked].filter(Boolean).join("\n\n"),
      idea: {
        topic: topic || "Идея Авроры",
        ...(row.hook?.trim() ? { hook: row.hook.trim() } : {}),
        ...(row.structure?.trim() ? { structure: row.structure.trim() } : {}),
        ...(row.why_it_worked?.trim() ? { whyItWorked: row.why_it_worked.trim() } : {}),
      },
      postedAt: iso(row.created_at),
      format: source ? normalizeLibraryFormat(source.media) : "text",
      saved: false,
      viewedAt: row.viewed_at ? iso(row.viewed_at) : null,
      userRating: numeric(row.rating),
      ...persistedScoredFields(source),
    };
  });

  const saved = savedResult.rows.map((row): LibraryRegistryItem => {
    const source = row.source_post_id ? sourceByPost.get(String(row.source_post_id)) : undefined;
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
      format: source ? normalizeLibraryFormat(source.media) : "text",
      saved: true,
      viewedAt: row.viewed_at ? iso(row.viewed_at) : null,
      userRating: numeric(row.rating),
      ...persistedScoredFields(source),
    };
  });

  const diagnosticRow = diagnosticsResult.rows[0];
  const selectedEngine = configuredServiceEngine(diagnosticRow?.ai_engine);
  const aiRuntime = resolveAiEngineRuntime(selectedEngine);
  const totalItemCount = references.length + ideas.length + saved.length;

  return {
    exportedAt: new Date().toISOString(),
    activeFilters: { ...filters, channelId },
    formulaVersion: LIBRARY_FORMULA_VERSION,
    channelId,
    channelTitle,
    diagnostics: {
      competitorCount: Number(diagnosticRow?.competitor_count || 0),
      sourcePostCount: Number(diagnosticRow?.source_post_count || 0),
      readyIdeaCount: ideas.length,
      pendingIdeaCount: Number(diagnosticRow?.pending_idea_count || 0),
      savedCount: saved.length,
      totalItemCount,
      aiEngine: aiRuntime.id,
      aiEngineLabel: aiRuntime.label,
      aiConfigured: aiRuntime.configured,
    },
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
