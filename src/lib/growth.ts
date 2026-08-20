import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import { ProjectAccessError, requireSelectedProjectPermission } from "./project-permissions";
import { resolveChannel } from "./autopilot";

export const GROWTH_TIME_ZONE = "Europe/Moscow";
export const GROWTH_MOVE_KINDS = ["topic", "rhythm", "offer", "audience"] as const;
export type GrowthMoveKind = (typeof GROWTH_MOVE_KINDS)[number];
export const GROWTH_MOVE_STATUSES = ["open", "done", "skipped"] as const;
export type GrowthMoveStatus = (typeof GROWTH_MOVE_STATUSES)[number];
export const GROWTH_CONFIDENCE = ["answered", "hypothesis", "insufficient_data"] as const;
export type GrowthConfidence = (typeof GROWTH_CONFIDENCE)[number];

export type GrowthDiagnosisItem = {
  id: string;
  text: string;
  confidence: GrowthConfidence;
  href?: string;
};

export type GrowthMoveDraft = {
  kind: GrowthMoveKind;
  confidence: GrowthConfidence;
  title: string;
  reason: string;
  prompt: string;
  sourceKind: "competitor_post" | "site_analysis" | "audience_question" | "stats" | null;
  sourceId: string | null;
  sourceLabel: string | null;
  missingSlots: number | null;
  fingerprint: string;
};

export type GrowthMoveRecord = GrowthMoveDraft & {
  id: number;
  status: GrowthMoveStatus;
  actionHref: string;
  weekStart: string;
};

export type GrowthBoard = {
  hasChannel: boolean;
  channelId: number | null;
  weekStart: string;
  previousWeekStart: string;
  diagnosis: GrowthDiagnosisItem[];
  moves: GrowthMoveRecord[];
  previousMoves: GrowthMoveRecord[];
  gaps: string[];
};

type OwnPost = { id: number; text: string; publishedAt: string };
type CompetitorHit = {
  id: number;
  text: string;
  views: number | null;
  handle: string;
  title: string | null;
};
type SiteOffer = {
  jobId: number;
  domain: string;
  answer: string;
  landing?: string | null;
};
type AudienceAsk = { id: number; question: string };

export type GrowthSignals = {
  ownPosts30d: OwnPost[];
  ownPosts7d: number;
  competitorCount: number;
  competitorHits: CompetitorHit[];
  competitorWeeklyMedian: number | null;
  siteOffer: SiteOffer | null;
  audienceQuestion: AudienceAsk | null;
};

const STOP_WORDS = new Set([
  "этот", "эта", "это", "того", "также", "после", "перед", "только", "можно",
  "нужно", "когда", "чтобы", "который", "которая", "которые", "сегодня",
  "просто", "очень", "более", "между", "через", "или", "если", "ваш", "ваша",
  "that", "this", "with", "from", "your", "have", "been", "will",
]);

export function moscowCalendarDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: GROWTH_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function growthWeekStart(now = new Date()): string {
  const ymd = moscowCalendarDate(now);
  const [year, month, day] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dow = utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return utc.toISOString().slice(0, 10);
}

export function previousGrowthWeekStart(weekStart: string): string {
  const [year, month, day] = weekStart.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day - 7));
  return utc.toISOString().slice(0, 10);
}

export function significantTokens(text: string): Set<string> {
  const matches = String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/gu, " ")
    .match(/[a-zа-яё0-9]{4,}/gu) ?? [];
  return new Set(matches.filter((token) => !STOP_WORDS.has(token)));
}

export function tokenOverlap(left: string, right: string): number {
  const a = significantTokens(left);
  const b = significantTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / Math.min(a.size, b.size);
}

export function coversTopic(ownPosts: OwnPost[], topicText: string): boolean {
  return ownPosts.some((post) => tokenOverlap(post.text, topicText) >= 0.28);
}

export function growthFingerprint(parts: {
  kind: GrowthMoveKind;
  sourceKind: GrowthMoveDraft["sourceKind"];
  sourceId: string | null;
}): string {
  return createHash("sha256")
    .update(`${parts.kind}:${parts.sourceKind ?? "none"}:${parts.sourceId ?? "none"}`)
    .digest("hex");
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function topicLabel(text: string): string {
  const firstLine = String(text || "").split(/\n/u)[0] || "";
  return clip(firstLine.replace(/^#+\s*/u, ""), 80) || "эту тему";
}

export function buildGrowthDiagnosis(signals: GrowthSignals): {
  diagnosis: GrowthDiagnosisItem[];
  gaps: string[];
} {
  const diagnosis: GrowthDiagnosisItem[] = [];
  const gaps: string[] = [];

  if (signals.competitorCount < 2) {
    gaps.push("Добавь хотя бы двух конкурентов — иначе сравнивать ритм и темы не с чем.");
  }
  if (!signals.siteOffer) {
    gaps.push("Нет разбора сайта — ход про услугу не ставлю.");
  }

  if (signals.competitorWeeklyMedian != null && signals.competitorCount >= 2) {
    const target = Math.max(3, Math.round(signals.competitorWeeklyMedian));
    if (signals.ownPosts7d < target) {
      diagnosis.push({
        id: "rhythm",
        text: `Ты пишешь реже конкурентов: ${signals.ownPosts7d} ${pluralPosts(signals.ownPosts7d)} за неделю против их ${target}.`,
        confidence: signals.ownPosts30d.length > 0 ? "answered" : "hypothesis",
        href: "/app/analytics",
      });
    }
  }

  const uncovered = signals.competitorHits.find((hit) => !coversTopic(signals.ownPosts30d, hit.text));
  if (uncovered) {
    const who = uncovered.title || `@${uncovered.handle}`;
    diagnosis.push({
      id: "topic",
      text: `У ${who} заходит «${topicLabel(uncovered.text)}», у тебя таких постов за 30 дней нет.`,
      confidence: "answered",
      href: "/app/competitors",
    });
  } else if (signals.competitorHits.length === 0 && signals.competitorCount >= 2) {
    diagnosis.push({
      id: "topic-empty",
      text: "Конкуренты добавлены, но залётов ещё нет — подожди ближайший сбор.",
      confidence: "insufficient_data",
      href: "/app/competitors",
    });
  }

  if (signals.siteOffer) {
    const mentioned = coversTopic(signals.ownPosts30d, signals.siteOffer.answer)
      || (signals.siteOffer.landing
        ? signals.ownPosts30d.some((post) => post.text.includes(signals.siteOffer!.domain))
        : false);
    if (!mentioned) {
      diagnosis.push({
        id: "offer",
        text: `На сайте есть услуга, а в канале про неё молчишь: ${clip(signals.siteOffer.answer, 120)}`,
        confidence: "answered",
        href: "/app/site-analysis",
      });
    }
  }

  if (signals.audienceQuestion) {
    diagnosis.push({
      id: "audience",
      text: `Люди спрашивают то, на что ещё нет поста: «${clip(signals.audienceQuestion.question, 120)}»`,
      confidence: "answered",
      href: "/app/studio/questions",
    });
  }

  return { diagnosis, gaps };
}

export function buildGrowthMoves(signals: GrowthSignals): GrowthMoveDraft[] {
  const drafts: GrowthMoveDraft[] = [];

  const uncovered = signals.competitorHits.find((hit) => !coversTopic(signals.ownPosts30d, hit.text));
  if (uncovered) {
    const who = uncovered.title || `@${uncovered.handle}`;
    const topic = topicLabel(uncovered.text);
    drafts.push({
      kind: "topic",
      confidence: "answered",
      title: `Напиши свой пост про «${topic}»`,
      reason: `Тема заходит у ${who}. Пишем новый текст в голосе канала, не копию.`,
      prompt: [
        `Напиши новый пост в голосе канала на тему: «${topic}».`,
        `Тема заходит у конкурента ${who}. Не копируй чужой текст — напиши свой.`,
      ].join(" "),
      sourceKind: "competitor_post",
      sourceId: String(uncovered.id),
      sourceLabel: who,
      missingSlots: null,
      fingerprint: growthFingerprint({
        kind: "topic",
        sourceKind: "competitor_post",
        sourceId: String(uncovered.id),
      }),
    });
  }

  if (signals.competitorWeeklyMedian != null && signals.competitorCount >= 2) {
    const target = Math.max(3, Math.round(signals.competitorWeeklyMedian));
    const missing = target - signals.ownPosts7d;
    if (missing > 0) {
      drafts.push({
        kind: "rhythm",
        confidence: signals.ownPosts30d.length > 0 ? "answered" : "hypothesis",
        title: `Верни ритм: не хватает ${missing} ${pluralPosts(missing)}`,
        reason: `За неделю вышло ${signals.ownPosts7d}, у конкурентов обычно около ${target}.`,
        prompt: `Собери недельный план так, чтобы закрыть дыру в ${missing} ${pluralPosts(missing)}.`,
        sourceKind: "stats",
        sourceId: "7d",
        sourceLabel: "своя статистика",
        missingSlots: Math.min(20, missing),
        fingerprint: growthFingerprint({ kind: "rhythm", sourceKind: "stats", sourceId: "7d" }),
      });
    }
  }

  if (signals.siteOffer) {
    const mentioned = coversTopic(signals.ownPosts30d, signals.siteOffer.answer)
      || signals.ownPosts30d.some((post) => post.text.includes(signals.siteOffer!.domain));
    if (!mentioned) {
      const landing = signals.siteOffer.landing ? ` Посадочная: ${signals.siteOffer.landing}.` : "";
      drafts.push({
        kind: "offer",
        confidence: "answered",
        title: "Сделай пост с понятным предложением",
        reason: clip(`На сайте есть услуга, в канале её не было: ${signals.siteOffer.answer}`, 500),
        prompt: clip(
          `Напиши пост с понятным предложением из разбора сайта: ${signals.siteOffer.answer}.${landing} Не обещай рост или результат, которого нет в фактах.`,
          2000,
        ),
        sourceKind: "site_analysis",
        sourceId: String(signals.siteOffer.jobId),
        sourceLabel: signals.siteOffer.domain,
        missingSlots: null,
        fingerprint: growthFingerprint({
          kind: "offer",
          sourceKind: "site_analysis",
          sourceId: String(signals.siteOffer.jobId),
        }),
      });
    }
  }

  if (drafts.length < 3 && signals.audienceQuestion) {
    drafts.push({
      kind: "audience",
      confidence: "answered",
      title: "Ответь на вопрос аудитории",
      reason: `Вопрос ещё без поста: «${clip(signals.audienceQuestion.question, 180)}»`,
      prompt: `Напиши пост-ответ на вопрос аудитории: «${clip(signals.audienceQuestion.question, 400)}»`,
      sourceKind: "audience_question",
      sourceId: String(signals.audienceQuestion.id),
      sourceLabel: "запрос аудитории",
      missingSlots: null,
      fingerprint: growthFingerprint({
        kind: "audience",
        sourceKind: "audience_question",
        sourceId: String(signals.audienceQuestion.id),
      }),
    });
  }

  return drafts.slice(0, 3);
}

export function growthActionHref(input: {
  id: number;
  kind: GrowthMoveKind;
  channelId: number;
  sourceId: string | null;
}): string {
  const params = new URLSearchParams({
    growthMove: String(input.id),
    channel: String(input.channelId),
  });
  if (input.kind === "rhythm") return `/app/autopilot?${params.toString()}`;
  if (input.kind === "audience") return "/app/studio/questions";
  params.set("intent", "create");
  return `/app/studio?${params.toString()}`;
}

function pluralPosts(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs >= 11 && abs <= 14) return "постов";
  if (last === 1) return "пост";
  if (last >= 2 && last <= 4) return "поста";
  return "постов";
}

function mapMove(row: {
  id: number | string;
  week_start: string;
  kind: string;
  status: string;
  confidence: string;
  title: string;
  reason: string;
  prompt: string;
  action_href: string;
  source_kind: string | null;
  source_id: string | null;
  source_label: string | null;
  fingerprint: string;
  missing_slots: number | null;
}): GrowthMoveRecord {
  return {
    id: Number(row.id),
    weekStart: String(row.week_start).slice(0, 10),
    kind: row.kind as GrowthMoveKind,
    status: row.status as GrowthMoveStatus,
    confidence: row.confidence as GrowthConfidence,
    title: row.title,
    reason: row.reason,
    prompt: row.prompt,
    actionHref: row.action_href,
    sourceKind: (row.source_kind as GrowthMoveRecord["sourceKind"]) ?? null,
    sourceId: row.source_id,
    sourceLabel: row.source_label,
    missingSlots: row.missing_slots == null ? null : Number(row.missing_slots),
    fingerprint: row.fingerprint,
  };
}

async function loadSignals(
  pool: Pick<Pool, "query">,
  input: { projectId: number; channelId: number },
): Promise<GrowthSignals> {
  const own = (
    await pool.query<{ id: string; text: string; published_at: string }>(
      `select id, text, published_at::text
         from posts
        where channel_id = $1
          and project_id = $2
          and status in ('published', 'published_unverified')
          and published_at >= now() - interval '30 days'
        order by published_at desc`,
      [input.channelId, input.projectId],
    )
  ).rows.map((row) => ({
    id: Number(row.id),
    text: row.text || "",
    publishedAt: row.published_at,
  }));

  const ownPosts7d = (
    await pool.query<{ n: string }>(
      `select count(*)::int as n
         from posts
        where channel_id = $1
          and project_id = $2
          and status in ('published', 'published_unverified')
          and published_at >= (
            date_trunc('day', now() at time zone 'Europe/Moscow') - interval '6 days'
          ) at time zone 'Europe/Moscow'`,
      [input.channelId, input.projectId],
    )
  ).rows[0];

  const competitorCount = Number((
    await pool.query<{ n: string }>(
      `select count(*)::int as n
         from competitors
        where channel_id = $1 and is_active = true`,
      [input.channelId],
    )
  ).rows[0]?.n ?? 0);

  const competitorHits = (
    await pool.query<{
      id: string;
      text: string | null;
      views: number | null;
      handle: string;
      title: string | null;
    }>(
      `select p.id, p.text, p.views, c.handle, coalesce(c.custom_title, c.title) as title
         from competitor_posts p
         join competitors c on c.id = p.competitor_id
        where c.channel_id = $1
          and c.is_active = true
          and p.posted_at >= now() - interval '30 days'
          and (
            p.is_hit = true
            or (p.views is not null and p.views >= 50)
          )
        order by p.is_hit desc, p.views desc nulls last, p.posted_at desc
        limit 12`,
      [input.channelId],
    )
  ).rows.map((row) => ({
    id: Number(row.id),
    text: row.text || "",
    views: row.views,
    handle: row.handle,
    title: row.title,
  }));

  const weekly = (
    await pool.query<{ weekly: string }>(
      `select percentile_cont(0.5) within group (order by weekly)::float as weekly
         from (
           select count(*)::float / 4.0 as weekly
             from competitor_posts p
             join competitors c on c.id = p.competitor_id
            where c.channel_id = $1
              and c.is_active = true
              and p.posted_at >= now() - interval '28 days'
            group by c.id
           having count(*) >= 4
         ) rates`,
      [input.channelId],
    )
  ).rows[0];

  const offerRow = (
    await pool.query<{
      job_id: string;
      domain: string;
      answer: string;
    }>(
      `select j.id as job_id, j.confirmed_domain as domain, a.short_answer as answer
         from site_analysis_jobs j
         join site_analysis_answers a
           on a.analysis_id = j.id and a.run_revision = j.run_revision
        where j.status = 'ready'
          and j.project_id = $1
          and a.question_id = 'offer.catalog'
          and a.status in ('answered', 'hypothesis')
        order by j.completed_at desc nulls last, j.id desc
        limit 1`,
      [input.projectId],
    )
  ).rows[0];

  const landingRow = offerRow
    ? (
      await pool.query<{ answer: string }>(
        `select a.short_answer as answer
           from site_analysis_answers a
          where a.analysis_id = $1
            and a.question_id = 'funnel.landing_pages'
            and a.status in ('answered', 'hypothesis')
          limit 1`,
        [Number(offerRow.job_id)],
      )
    ).rows[0]
    : null;

  const audienceRow = (
    await pool.query<{ id: string; question: string }>(
      `select id, question
         from audience_questions
        where project_id = $1 and status = 'new'
        order by priority desc, occurrences desc, last_seen_at desc, id desc
        limit 1`,
      [input.projectId],
    )
  ).rows[0];

  return {
    ownPosts30d: own,
    ownPosts7d: Number(ownPosts7d?.n ?? 0),
    competitorCount,
    competitorHits,
    competitorWeeklyMedian: weekly?.weekly == null ? null : Number(weekly.weekly),
    siteOffer: offerRow
      ? {
        jobId: Number(offerRow.job_id),
        domain: offerRow.domain,
        answer: offerRow.answer,
        landing: landingRow?.answer ?? null,
      }
      : null,
    audienceQuestion: audienceRow
      ? { id: Number(audienceRow.id), question: audienceRow.question }
      : null,
  };
}

async function loadWeekMoves(
  pool: Pick<Pool, "query">,
  channelId: number,
  weekStart: string,
): Promise<GrowthMoveRecord[]> {
  const rows = (
    await pool.query(
      `select id, week_start::text, kind, status, confidence, title, reason, prompt,
              action_href, source_kind, source_id, source_label, fingerprint, missing_slots
         from growth_moves
        where channel_id = $1 and week_start = $2::date
        order by id`,
      [channelId, weekStart],
    )
  ).rows;
  return rows.map(mapMove);
}

async function growthBoard(input: {
  actorUserId: number;
  channelId?: number | null;
}, ensure: boolean): Promise<GrowthBoard> {
  const pool = getPool();
  const membership = await requireSelectedProjectPermission(
    pool,
    input.actorUserId,
    ensure ? "content.create" : "project.read",
  );
  const channelId = await resolveChannel(
    { actorUserId: input.actorUserId, projectId: membership.projectId },
    input.channelId ?? null,
  );
  const weekStart = growthWeekStart();
  const previousWeekStart = previousGrowthWeekStart(weekStart);
  if (!channelId) {
    return {
      hasChannel: false,
      channelId: null,
      weekStart,
      previousWeekStart,
      diagnosis: [],
      moves: [],
      previousMoves: [],
      gaps: ["Подключи Telegram-канал — без него развитие считать не на чем."],
    };
  }

  const signals = await loadSignals(pool, {
    projectId: membership.projectId,
    channelId,
  });
  const { diagnosis, gaps } = buildGrowthDiagnosis(signals);

  let moves: GrowthMoveRecord[];
  if (!ensure) {
    moves = await loadWeekMoves(pool, channelId, weekStart);
  } else {
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `growth:${channelId}:${weekStart}`,
      ]);
      const existing = await loadWeekMoves(client, channelId, weekStart);
      const incompleteLegacySet = existing.some((move) => move.actionHref === "/app/growth");
      if (existing.length === 0 || incompleteLegacySet) {
        const drafts = buildGrowthMoves(signals);
        for (const draft of drafts) {
          await client.query(
            `insert into growth_moves (
               project_id, channel_id, week_start, kind, status, confidence,
               title, reason, prompt, action_href, source_kind, source_id,
               source_label, fingerprint, missing_slots
             ) values (
               $1, $2, $3::date, $4, 'open', $5,
               $6, $7, $8, '/app/growth', $9, $10,
               $11, $12, $13
             )
             on conflict (channel_id, week_start, fingerprint) do nothing`,
            [
              membership.projectId,
              channelId,
              weekStart,
              draft.kind,
              draft.confidence,
              clip(draft.title, 200),
              clip(draft.reason, 500),
              clip(draft.prompt, 2000),
              draft.sourceKind,
              draft.sourceId,
              draft.sourceLabel,
              draft.fingerprint,
              draft.missingSlots,
            ],
          );
        }
      }
      moves = await loadWeekMoves(client, channelId, weekStart);
      let actionHrefUpdated = false;
      for (const move of moves) {
        const href = growthActionHref({
          id: move.id,
          kind: move.kind,
          channelId,
          sourceId: move.sourceId,
        });
        if (move.actionHref === href) continue;
        await client.query(
          `update growth_moves
              set action_href = $2, updated_at = now()
            where id = $1 and project_id = $3 and channel_id = $4`,
          [move.id, href, membership.projectId, channelId],
        );
        actionHrefUpdated = true;
      }
      if (actionHrefUpdated) {
        moves = await loadWeekMoves(client, channelId, weekStart);
      }
      await client.query("commit");
    } catch (error) {
      if (client) await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client?.release();
    }
  }

  const previousMoves = await loadWeekMoves(pool, channelId, previousWeekStart);
  return {
    hasChannel: true,
    channelId,
    weekStart,
    previousWeekStart,
    diagnosis,
    moves,
    previousMoves,
    gaps,
  };
}

export async function loadGrowthBoard(input: {
  actorUserId: number;
  channelId?: number | null;
}): Promise<GrowthBoard> {
  return growthBoard(input, false);
}

export async function ensureGrowthBoard(input: {
  actorUserId: number;
  channelId?: number | null;
}): Promise<GrowthBoard> {
  return growthBoard(input, true);
}

export async function getGrowthMove(input: {
  actorUserId: number;
  moveId: number;
}): Promise<GrowthMoveRecord | null> {
  if (!Number.isSafeInteger(input.moveId) || input.moveId <= 0) return null;
  const pool = getPool();
  const membership = await requireSelectedProjectPermission(pool, input.actorUserId, "project.read");
  const row = (
    await pool.query(
      `select id, week_start::text, kind, status, confidence, title, reason, prompt,
              action_href, source_kind, source_id, source_label, fingerprint, missing_slots
         from growth_moves
        where id = $1 and project_id = $2`,
      [input.moveId, membership.projectId],
    )
  ).rows[0];
  return row ? mapMove(row) : null;
}

export async function updateGrowthMoveStatus(input: {
  actorUserId: number;
  moveId: number;
  status: Exclude<GrowthMoveStatus, "open">;
}): Promise<GrowthMoveRecord | null> {
  const current = await getGrowthMove(input);
  if (!current) return null;
  const pool = getPool();
  const membership = await requireSelectedProjectPermission(pool, input.actorUserId, "content.edit");
  const row = (
    await pool.query(
      `update growth_moves
          set status = $3, updated_at = now()
        where id = $1 and project_id = $2
        returning id, week_start::text, kind, status, confidence, title, reason, prompt,
                  action_href, source_kind, source_id, source_label, fingerprint, missing_slots`,
      [input.moveId, membership.projectId, input.status],
    )
  ).rows[0];
  return row ? mapMove(row) : null;
}

export function isGrowthAccessError(error: unknown): boolean {
  return error instanceof ProjectAccessError;
}
