// Shared by the HTTP and BullMQ paths: new evidence can add candidates throughout the week.
import { createHash } from "node:crypto";
import {
    buildProfileFallbackCandidates,
    loadChannelMarketCandidates,
    researchProfile,
} from "./opportunity-market.mjs";
export const GROWTH_TIME_ZONE = "Europe/Moscow";
const STOP_WORDS = new Set([
    "этот", "эта", "это", "того", "также", "после", "перед", "только", "можно",
    "нужно", "когда", "чтобы", "который", "которая", "которые", "сегодня",
    "просто", "очень", "более", "между", "через", "или", "если", "ваш", "ваша",
    "that", "this", "with", "from", "your", "have", "been", "will",
]);
export function moscowCalendarDate(now = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: GROWTH_TIME_ZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(now);
}
export function growthWeekStart(now = new Date()) {
    const ymd = moscowCalendarDate(now);
    const [year, month, day] = ymd.split("-").map(Number);
    const utc = new Date(Date.UTC(year, month - 1, day));
    const dow = utc.getUTCDay();
    utc.setUTCDate(utc.getUTCDate() - (dow === 0 ? 6 : dow - 1));
    return utc.toISOString().slice(0, 10);
}
export function significantTokens(text) {
    const matches = String(text || "")
        .toLowerCase()
        .replace(/https?:\/\/\S+/gu, " ")
        .match(/[a-zа-яё0-9]{4,}/gu) ?? [];
    return new Set(matches.filter((token) => !STOP_WORDS.has(token)));
}
export function tokenOverlap(left, right) {
    const a = significantTokens(left);
    const b = significantTokens(right);
    if (a.size === 0 || b.size === 0)
        return 0;
    let shared = 0;
    for (const token of a) {
        if (b.has(token))
            shared += 1;
    }
    return shared / Math.min(a.size, b.size);
}
export function coversTopic(ownPosts, topicText) {
    return ownPosts.some((post) => tokenOverlap(post.text, topicText) >= 0.28);
}
export function growthFingerprint(parts) {
    return createHash("sha256")
        .update(`${parts.kind}:${parts.sourceKind ?? "none"}:${parts.sourceId ?? "none"}`)
        .digest("hex");
}
function clip(text, max) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= max)
        return clean;
    return `${clean.slice(0, max - 1).trimEnd()}…`;
}
function topicLabel(text) {
    const firstLine = String(text || "").split(/\n/u)[0] || "";
    return clip(firstLine.replace(/^#+\s*/u, ""), 80) || "эту тему";
}
const KIND_TIE_BREAK = {
    topic: 0,
    offer: 1,
    audience: 2,
    rhythm: 3,
};
export function goalFitForMove(goal, kind) {
    const value = String(goal ?? "").toLocaleLowerCase("ru");
    if (!value)
        return 0;
    if (/продаж|заяв|выруч|клиент|лид/u.test(value)) {
        return { offer: 5, audience: 4, topic: 2, rhythm: 2 }[kind];
    }
    if (/вовлеч|комьюнити|сообществ|диалог|общени/u.test(value)) {
        return { audience: 5, topic: 4, rhythm: 3, offer: 2 }[kind];
    }
    if (/охват|бренд|узнаваем|подпис|аудитор/u.test(value)) {
        return { topic: 5, rhythm: 4, audience: 3, offer: 2 }[kind];
    }
    if (/трафик|переход|сайт/u.test(value)) {
        return { offer: 4, topic: 4, audience: 3, rhythm: 2 }[kind];
    }
    return 1;
}
export function evidenceWeight(confidence) {
    if (confidence === "answered")
        return 4;
    if (confidence === "hypothesis")
        return 2;
    return 0;
}
export function effortWeight(effort) {
    if (effort === "Небольшое")
        return 2;
    if (effort === "Среднее")
        return 1;
    return 0;
}
export function rankGrowthMoves(drafts, goal, limit = 3) {
    return drafts
        .map((draft) => ({
        draft,
        score: (Number(draft.evidence.priorityScore) || 0) / 5
            + goalFitForMove(goal, draft.kind)
            + evidenceWeight(draft.confidence)
            + Math.max(0, Math.min(4, draft.evidence.opportunityStrength))
            + Math.max(0, Math.min(3, draft.evidence.urgency))
            + effortWeight(draft.evidence.effort)
            + (draft.prompt.trim() && draft.sourceKind ? 2 : 0),
    }))
        .sort((left, right) => right.score - left.score
        || KIND_TIE_BREAK[left.draft.kind] - KIND_TIE_BREAK[right.draft.kind]
        || left.draft.fingerprint.localeCompare(right.draft.fingerprint))
        .slice(0, limit)
        .map(({ draft }, index) => ({ ...draft, rankPosition: index + 1 }));
}
function evidence(input) {
    return {
        ...input,
        freshnessLabel: input.observedAt ? humanFreshness(input.observedAt) : "Дата источника недоступна",
    };
}

function marketSourceType(candidate) {
    if (candidate.type === "breaking_news") return "Свежая новость";
    if (candidate.sourceKind === "channel_profile") return "Профиль канала";
    return "Рыночный сигнал";
}

function marketMove(candidate) {
    const isProfileFallback = candidate.sourceKind === "channel_profile";
    const hasStrongEvidence = candidate.sourceCount >= 2 && candidate.trust >= 60;
    const primarySource = candidate.sources?.[0];
    const whyNow = candidate.type === "breaking_news"
        ? "Новость свежая: выпусти разбор, пока тема находится в активной повестке."
        : candidate.type === "rising_topic"
            ? "Тема появилась в открытых источниках и подходит профилю канала."
            : "В профиле канала есть тема, которую можно раскрыть даже без истории публикаций.";
    const formatSuggestion = candidate.type === "breaking_news" ? "Короткий разбор новости"
        : candidate.type === "rising_topic" ? "Авторский разбор с практическим выводом"
            : "Практический пост";
    return {
        kind: "topic",
        confidence: hasStrongEvidence ? "answered" : "hypothesis",
        title: candidate.title,
        reason: clip(candidate.summary || whyNow, 320),
        prompt: clip([
            `Напиши ${formatSuggestion.toLocaleLowerCase("ru-RU")} в голосе канала на тему: «${candidate.title}».`,
            candidate.summary,
            isProfileFallback
                ? "Опирайся на подтверждённый профиль канала и не придумывай внешние факты."
                : "Проверь факты по указанным источникам, добавь собственный вывод и не копируй исходный текст.",
            "Не обещай результат, которого нет в фактах.",
        ].filter(Boolean).join(" "), 2_000),
        sourceKind: candidate.sourceKind,
        sourceId: candidate.sourceId,
        sourceLabel: candidate.sourceLabel,
        missingSlots: null,
        fingerprint: growthFingerprint({
            kind: "topic",
            sourceKind: candidate.sourceKind,
            sourceId: candidate.sourceId,
        }),
        evidence: evidence({
            sourceType: marketSourceType(candidate),
            sourceLabel: candidate.sourceLabel,
            href: primarySource?.url || (isProfileFallback ? "/app/settings?section=content" : "/app/radar"),
            sampleSize: candidate.sourceCount,
            periodLabel: candidate.type === "breaking_news" ? "последние 7 дней" : "последние 30 дней",
            observedAt: candidate.observedAt,
            methodology: isProfileFallback
                ? "Стартовая возможность построена из подтверждённой ниши и рубрик канала. Это гипотеза, которую нужно проверить публикацией."
                : "Аврора сопоставляет публичный сигнал с нишей, аудиторией и рубриками канала, затем оценивает свежесть, надёжность и свободное место в контенте.",
            metricLabel: isProfileFallback
                ? "Стартовая тема из профиля; внешних источников пока нет"
                : `${candidate.sourceCount} ${candidate.sourceCount === 1 ? "открытый источник" : "открытых источника"}; релевантность ${candidate.relevance}%`,
            opportunityStrength: Math.max(1, Math.ceil(candidate.priority / 25)),
            urgency: candidate.type === "breaking_news" ? 3 : candidate.type === "rising_topic" ? 2 : 1,
            effort: candidate.type === "breaking_news" ? "Небольшое" : "Среднее",
            opportunityType: candidate.type,
            priorityScore: candidate.priority,
            profileHash: candidate.profileHash,
            publishBefore: candidate.publishBefore,
            expiresAt: candidate.expiresAt,
            sourceCount: candidate.sourceCount,
            sources: candidate.sources,
            whyNow,
            relevanceScore: candidate.relevance,
            momentumScore: candidate.momentum,
            freshnessScore: candidate.freshness,
            trustScore: candidate.trust,
            whitespaceScore: 75,
            formatSuggestion,
        }),
    };
}

export function buildGrowthMoves(signals, limit = 3) {
    const drafts = [];
    const covered = [...signals.ownPosts30d];
    for (const uncovered of signals.competitorHits) {
        if (!uncovered.text.trim() || coversTopic(covered, uncovered.text))
            continue;
        covered.push({ id: uncovered.id, text: uncovered.text, publishedAt: "" });
        const who = uncovered.title || `@${uncovered.handle}`;
        const topic = topicLabel(uncovered.text);
        drafts.push({
            kind: "topic",
            confidence: signals.competitorCount >= 2 && signals.competitorHits.length >= 3
                ? "answered" : "hypothesis",
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
            evidence: evidence({
                sourceType: "Пост конкурента",
                sourceLabel: who,
                href: "/app/competitors",
                sampleSize: signals.competitorHits.length || null,
                periodLabel: "последние 30 дней",
                observedAt: uncovered.postedAt ?? signals.latestDataAt,
                methodology: "Сравниваем подтверждённые залёты добавленных конкурентов с темами твоих публикаций за 30 дней.",
                metricLabel: uncovered.views == null
                    ? "Пост отмечен как залёт; просмотры недоступны"
                    : `${uncovered.views} просмотров у исходного поста`,
                opportunityStrength: uncovered.views != null && uncovered.views >= 1_000 ? 4 : 3,
                urgency: 2,
                effort: "Среднее",
            }),
        });
    }
    const marketCandidates = [
        ...(signals.marketCandidates ?? []),
        ...buildProfileFallbackCandidates(signals.researchProfile),
    ];
    const seenFingerprints = new Set(drafts.map((draft) => draft.fingerprint));
    for (const candidate of marketCandidates) {
        if (!candidate.title?.trim() || coversTopic(signals.ownPosts30d, candidate.title)) continue;
        const draft = marketMove(candidate);
        if (seenFingerprints.has(draft.fingerprint)) continue;
        seenFingerprints.add(draft.fingerprint);
        drafts.push(draft);
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
                evidence: evidence({
                    sourceType: "Статистика публикаций",
                    sourceLabel: "своя статистика и ритм конкурентов",
                    href: "/app/analytics",
                    sampleSize: signals.competitorCount,
                    periodLabel: "7 дней против медианы за 28 дней",
                    observedAt: signals.latestDataAt,
                    methodology: "Сравниваем число твоих публикаций за 7 дней с медианным недельным темпом активных конкурентов за 28 дней.",
                    metricLabel: `${signals.ownPosts7d} против медианы ${target}; не хватает ${missing}`,
                    opportunityStrength: missing >= 3 ? 4 : missing >= 2 ? 3 : 2,
                    urgency: missing >= 2 ? 3 : 2,
                    effort: missing >= 4 ? "Заметное" : "Среднее",
                }),
            });
        }
    }
    if (signals.siteOffer) {
        const mentioned = coversTopic(signals.ownPosts30d, signals.siteOffer.answer)
            || signals.ownPosts30d.some((post) => post.text.includes(signals.siteOffer.domain));
        if (!mentioned) {
            const landing = signals.siteOffer.landing ? ` Посадочная: ${signals.siteOffer.landing}.` : "";
            drafts.push({
                kind: "offer",
                confidence: "answered",
                title: "Сделай пост с понятным предложением",
                reason: clip(`На сайте есть услуга, в канале её не было: ${signals.siteOffer.answer}`, 500),
                prompt: clip(`Напиши пост с понятным предложением из разбора сайта: ${signals.siteOffer.answer}.${landing} Не обещай рост или результат, которого нет в фактах.`, 2000),
                sourceKind: "site_analysis",
                sourceId: String(signals.siteOffer.jobId),
                sourceLabel: signals.siteOffer.domain,
                missingSlots: null,
                fingerprint: growthFingerprint({
                    kind: "offer",
                    sourceKind: "site_analysis",
                    sourceId: String(signals.siteOffer.jobId),
                }),
                evidence: evidence({
                    sourceType: "Разбор сайта",
                    sourceLabel: signals.siteOffer.domain,
                    href: "/app/site-analysis",
                    sampleSize: 1,
                    periodLabel: "последний завершённый разбор",
                    observedAt: signals.latestDataAt,
                    methodology: "Сопоставляем подтверждённое предложение из последнего разбора сайта с темами публикаций канала за 30 дней.",
                    metricLabel: "Предложение найдено на сайте, но не найдено в недавних постах",
                    opportunityStrength: 4,
                    urgency: 2,
                    effort: "Среднее",
                }),
            });
        }
    }
    for (const audienceQuestion of signals.audienceQuestions ?? (signals.audienceQuestion ? [signals.audienceQuestion] : [])) {
        drafts.push({
            kind: "audience",
            confidence: "answered",
            title: `Ответь на вопрос: «${clip(audienceQuestion.question, 120)}»`,
            reason: `Вопрос ещё без поста: «${clip(audienceQuestion.question, 180)}»`,
            prompt: `Напиши пост-ответ на вопрос аудитории: «${clip(audienceQuestion.question, 400)}»`,
            sourceKind: "audience_question",
            sourceId: String(audienceQuestion.id),
            sourceLabel: "запрос аудитории",
            missingSlots: null,
            fingerprint: growthFingerprint({
                kind: "audience",
                sourceKind: "audience_question",
                sourceId: String(audienceQuestion.id),
            }),
            evidence: evidence({
                sourceType: "Запрос аудитории",
                sourceLabel: "запрос аудитории",
                href: "/app/studio/questions",
                sampleSize: audienceQuestion.occurrences ?? 1,
                periodLabel: "актуальный открытый запрос",
                observedAt: audienceQuestion.lastSeenAt ?? signals.latestDataAt,
                methodology: "Берём открытый вопрос с наивысшим приоритетом и частотой, на который ещё нет связанного ответа.",
                metricLabel: audienceQuestion.occurrences && audienceQuestion.occurrences > 1
                    ? `${audienceQuestion.occurrences} похожих обращения`
                    : "1 подтверждённый вопрос",
                opportunityStrength: (audienceQuestion.occurrences ?? 1) >= 3 ? 4 : 3,
                urgency: 3,
                effort: "Небольшое",
            }),
        });
    }
    return rankGrowthMoves(drafts, signals.goal, limit);
}
function pluralPosts(n) {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    if (abs >= 11 && abs <= 14)
        return "постов";
    if (last === 1)
        return "пост";
    if (last >= 2 && last <= 4)
        return "поста";
    return "постов";
}
export function humanFreshness(value, now = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime()))
        return "Свежесть неизвестна";
    const hours = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 3_600_000));
    if (hours < 1)
        return "Обновлено меньше часа назад";
    if (hours < 24)
        return `Обновлено ${hours} ч назад`;
    const days = Math.floor(hours / 24);
    return `Обновлено ${days} ${days === 1 ? "день" : days < 5 ? "дня" : "дней"} назад`;
}
export async function loadSignals(pool, input) {
    const own = (await pool.query(`select id, text, published_at::text
         from posts
        where channel_id = $1
          and project_id = $2
          and status in ('published', 'published_unverified')
          and published_at >= now() - interval '30 days'
        order by published_at desc`, [input.channelId, input.projectId])).rows.map((row) => ({
        id: Number(row.id),
        text: row.text || "",
        publishedAt: row.published_at,
    }));
    const ownPosts7d = (await pool.query(`select count(*)::int as n
         from posts
        where channel_id = $1
          and project_id = $2
          and status in ('published', 'published_unverified')
          and published_at >= (
            date_trunc('day', now() at time zone 'Europe/Moscow') - interval '6 days'
          ) at time zone 'Europe/Moscow'`, [input.channelId, input.projectId])).rows[0];
    const competitorCount = Number((await pool.query(`select count(*)::int as n
         from competitors
        where channel_id = $1 and is_active = true`, [input.channelId])).rows[0]?.n ?? 0);
    const competitorHits = (await pool.query(`select p.id, p.text, p.views, p.posted_at::text, c.handle, coalesce(c.custom_title, c.title) as title
         from competitor_posts p
         join competitors c on c.id = p.competitor_id
        where c.channel_id = $1
          and c.is_active = true
          and p.posted_at >= now() - interval '30 days'
          and (
            p.is_hit = true
            or (p.views is not null and p.views >= 50)
          )
        order by p.posted_at desc, p.is_hit desc, p.views desc nulls last, p.id desc
        limit 60`, [input.channelId])).rows.map((row) => ({
        id: Number(row.id),
        text: row.text || "",
        views: row.views,
        postedAt: row.posted_at,
        handle: row.handle,
        title: row.title,
    }));
    const weekly = (await pool.query(`select percentile_cont(0.5) within group (order by weekly)::float as weekly
         from (
           select count(*)::float / 4.0 as weekly
             from competitor_posts p
             join competitors c on c.id = p.competitor_id
            where c.channel_id = $1
              and c.is_active = true
              and p.posted_at >= now() - interval '28 days'
            group by c.id
           having count(*) >= 4
         ) rates`, [input.channelId])).rows[0];
    const offerRow = (await pool.query(`select j.id as job_id, j.confirmed_domain as domain, a.short_answer as answer
         from site_analysis_jobs j
         join site_analysis_answers a
           on a.analysis_id = j.id and a.run_revision = j.run_revision
        where j.status = 'ready'
          and j.project_id = $1
          and a.question_id = 'offer.catalog'
          and a.status in ('answered', 'hypothesis')
        order by j.completed_at desc nulls last, j.id desc
        limit 1`, [input.projectId])).rows[0];
    const landingRow = offerRow
        ? (await pool.query(`select a.short_answer as answer
           from site_analysis_answers a
          where a.analysis_id = $1
            and a.question_id = 'funnel.landing_pages'
            and a.status in ('answered', 'hypothesis')
          limit 1`, [Number(offerRow.job_id)])).rows[0]
        : null;
    const audienceRows = (await pool.query(`select id, question, occurrences, last_seen_at::text
         from audience_questions
        where project_id = $1 and status = 'new'
          and 1 = (
            select count(*)::int from channels
             where project_id = $1 and network = 'tg' and is_active = true and status = 'active'
          )
        order by priority desc, occurrences desc, last_seen_at desc, id desc
        limit 12`, [input.projectId])).rows;
    const audienceRow = audienceRows[0];
    const briefRow = (await pool.query(`select nullif(btrim(niche), '') as niche,
              nullif(btrim(audience), '') as audience,
              coalesce(rubrics, '{}'::text[]) as rubrics,
              nullif(btrim(goal), '') as goal,
              nullif(btrim(taboo), '') as taboo,
              coalesce(formats, '{}'::text[]) as formats,
              coalesce(opportunity_keywords, '{}'::text[]) as opportunity_keywords,
              coalesce(excluded_keywords, '{}'::text[]) as excluded_keywords,
              coalesce(nullif(btrim(language), ''), 'ru') as language,
              nullif(btrim(region), '') as region
         from content_brief
        where project_id = $1 and channel_id = $2
        order by ready desc, updated_at desc
        limit 1`, [input.projectId, input.channelId])).rows[0];
    const profile = briefRow ? researchProfile({
        niche: briefRow.niche,
        audience: briefRow.audience,
        rubrics: briefRow.rubrics,
        goal: briefRow.goal,
        taboo: briefRow.taboo,
        formats: briefRow.formats,
        opportunityKeywords: briefRow.opportunity_keywords,
        excludedKeywords: briefRow.excluded_keywords,
        language: briefRow.language,
        region: briefRow.region,
    }) : null;
    const marketCandidates = profile && (profile.niche || profile.rubrics.length || profile.opportunityKeywords.length)
        ? await loadChannelMarketCandidates(pool, input, profile)
        : [];
    const ownPublishedCount = Number((await pool.query(`select count(*)::int as n
         from posts
        where project_id = $1 and channel_id = $2
          and status in ('published', 'published_unverified')`, [input.projectId, input.channelId])).rows[0]?.n ?? 0);
    const latestDataAt = (await pool.query(`select greatest(
          (select max(stats.collected_at) from post_stats stats
            join posts post on post.id = stats.post_id and post.project_id = stats.project_id
           where stats.project_id = $1 and post.channel_id = $2),
          (select max(posted_at) from competitor_posts post
            join competitors competitor on competitor.id = post.competitor_id
           where competitor.channel_id = $2 and competitor.is_active = true)
        )::text as collected_at`, [input.projectId, input.channelId])).rows[0]?.collected_at ?? null;
    const trackingStatus = (await pool.query(`select status from project_tracking_settings where project_id = $1`, [input.projectId])).rows[0]?.status ?? null;
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
            ? {
                id: Number(audienceRow.id),
                question: audienceRow.question,
                occurrences: Number(audienceRow.occurrences) || 1,
                lastSeenAt: audienceRow.last_seen_at,
            }
            : null,
        audienceQuestions: audienceRows.map(row => ({ id: Number(row.id), question: row.question, occurrences: Number(row.occurrences) || 1, lastSeenAt: row.last_seen_at })),
        goal: briefRow?.goal ?? null,
        researchProfile: profile,
        marketCandidates,
        ownPublishedCount,
        latestDataAt,
        trackingStatus,
    };
}

/** Caller holds the channel/week transaction lock. Existing actions are never reset. */
export async function persistGrowthCandidates(db, scope, drafts, weekStart) {
        for (const draft of drafts) {
          await db.query(
            `insert into growth_moves (
               project_id, channel_id, week_start, kind, status, confidence,
               title, reason, prompt, action_href, source_kind, source_id,
               source_label, fingerprint, missing_slots, rank_position, evidence
             ) select
               $1, $2, $3::date, $4, 'open', $5,
               $6, $7, $8, '/app/growth', $9, $10,
               $11, $12, $13, $14, $15::jsonb
             where $4 = 'rhythm' or not exists (
               select 1 from growth_moves previous
                where previous.project_id = $1 and previous.channel_id = $2
                  and previous.fingerprint = $12 and previous.week_start <> $3::date
                  and previous.created_at >= now() - interval '30 days'
             )
             on conflict (channel_id, week_start, fingerprint) do nothing`,
            [
              scope.projectId,
              scope.channelId,
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
              draft.rankPosition && draft.rankPosition <= 3 ? draft.rankPosition : null,
              JSON.stringify(draft.evidence),
            ],
          );
        }
}
