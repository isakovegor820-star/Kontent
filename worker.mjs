// Д.3 — воркер публикации. Отдельный «всегда включённый» процесс: слушает очередь
// и публикует посты точно в срок с сервера. Пользователь может закрыть ноутбук —
// задача всё равно сработает.
//
// Запуск:  npm run worker   (== node --env-file=.env.local worker.mjs)
// На деплое переезжает на Railway/Render/свой сервер (Vercel для него не подходит).

import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";
import { createHash } from "node:crypto";
// Чистые функции (парсинг, страж фактов, раскладка, разметка) вынесены в отдельный модуль
// без сайд-эффектов — так их можно тестировать, не поднимая пул/Redis/BullMQ.
import {
  parseCount,
  sumReactions,
  decodeEntities,
  splitChunks,
  plural,
  mskDatePlus,
  weekSlots,
  toTelegramHtml,
  keyboard,
  findInvented,
  stripCites,
  citedShare,
  mapConcurrent,
  formatPost,
} from "./worker/lib.mjs";
import { collectRssPipeline } from "./worker/rss-pipeline.mjs";
import { buildWeeklyReport } from "./worker/weekly-report.mjs";
import {
  MEDIA_QUEUE,
  assertSafeMediaUrl,
  buildNavyMediaPayload,
  detectMediaMime,
} from "./src/lib/media-generation.mjs";
// Шифрование токенов сообществ (VK) и OAuth-сетей (YouTube/Instagram). Крипто НЕ дублируем —
// один модуль на роуты и воркер. encryptToken нужен для сохранения обновлённого access_token.
import { decryptToken, encryptToken } from "./src/lib/token-crypto.mjs";
// Реестр провайдеров соцсетей (адаптеры публикации + OAuth-конфиги для рефреша токенов).
// Тот же модуль, что используют роуты подключения — ноль дублирования OAuth-логики.
import { getAdapter, getOAuthConfig } from "./src/lib/social-providers.mjs";
import { refreshAccessToken } from "./src/lib/oauth.mjs";
// Профиль канала (невидимая база знаний): промпт извлечения, парсер ответа модели и
// сборка текста источника — общий чистый модуль с Next-роутами, без дублирования.
import {
  buildExtractionMessages,
  parseProfile,
  profileToSourceText,
} from "./src/lib/channel-profile.mjs";
import {
  buildQualityPrompt,
  buildRewritePrompt,
  fallbackTopicFromSeed,
  normalizePostQuality,
  validatePostQuality,
  validateTopicQuality,
} from "./src/lib/post-quality.mjs";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const DATABASE_URL = process.env.DATABASE_URL;
const TOKEN = process.env.TG_BOT_TOKEN;
const OWNER_CHAT = process.env.TG_CHAT_ID;
// Repair mode for local incidents: process manual/background jobs without starting the
// publication queue, cron or Telegram polling. It lets us recover Autopilot without an
// overdue scheduled post suddenly going live. Normal `npm run worker` remains full mode.
const AUTOPILOT_ONLY = process.env.AURORA_WORKER_MODE === "autopilot";
const MEDIA_ONLY = process.env.AURORA_WORKER_MODE === "media";

// ИИ-движок для генерации идей (Д.7) и планов (Д.9). Тот же выбор, что в переходнике
// ai-provider.ts: облако, если задан AI_API_KEY; иначе локальный Ollama (hermes3).
// Добавил ключ → и студия, и воркер переключаются на облако. Код не меняем.
const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const AI_MODEL = process.env.AI_MODEL || "hermes3";
const CLOUD_KEY = process.env.AI_API_KEY || "";
const CLOUD_URL = (process.env.AI_API_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const CLOUD_MODEL = process.env.AI_CLOUD_MODEL || "gpt-4o-mini";

// ── База знаний (РАГ) ────────────────────────────────────────────────────────
// Модель эмбеддингов ОБЯЗАНА быть многоязычной: дефолтные nomic-embed-text и
// all-MiniLM обучены на английском и на русском путают смыслы. bge-m3 замерена на
// живых юридических кусках: 4 из 4 в топ-1, релевантный кусок 0.671 против 0.240
// у постороннего — зазор чистый, по нему и стоит порог.
const EMBED_MODEL = process.env.EMBED_MODEL || "bge-m3";
const EMBED_DIM = 1024; // bge-m3. Сменишь модель — меняй и vector(N) в схеме.
const EMBED_CLOUD_MODEL = process.env.EMBED_CLOUD_MODEL || "text-embedding-3-small";

/**
 * Вектор текста. null — движок недоступен (кусок останется непроиндексированным,
 * и это честно: лучше пустая база, чем база с враньём).
 */
async function embed(text) {
  const input = String(text || "").trim();
  if (!input) return null;
  try {
    if (CLOUD_KEY) {
      const r = await fetch(`${CLOUD_URL}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${CLOUD_KEY}` },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ model: EMBED_CLOUD_MODEL, input }),
      });
      if (!r.ok) return null;
      const d = await r.json();
      return d?.data?.[0]?.embedding ?? null;
    }
    const r = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ model: EMBED_MODEL, input }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const v = d?.embeddings?.[0] ?? d?.embedding ?? null;
    // Размерность сверяем ЗДЕСЬ: иначе несовпадение всплывёт как ошибка Postgres
    // на вставке, и понять из неё, что дело в подменённой модели, будет нельзя.
    if (v && v.length !== EMBED_DIM) {
      console.error(`[база] ${EMBED_MODEL} даёт ${v.length} измерений, схема ждёт ${EMBED_DIM}`);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

/** Формат pgvector: '[0.1,0.2,...]'. */
const toVector = (v) => `[${v.join(",")}]`;

// ── Поиск опоры в базе знаний ────────────────────────────────────────────────
//
// Гибрид: вектор + слова. Не «для качества вообще», а по замерам на живой базе:
//
//  • Запрос «статья 446 ГПК» вектор оценил в 0.395 — НИЖЕ порога опоры. То есть кусок,
//    содержащий «статья 446 ГПК РФ» дословно, был бы объявлен ненайденным, и система
//    отказалась бы писать. Текстовый поиск находит его сразу. Векторы глухи к цифрам и
//    реквизитам — а юристу нужны именно они.
//  • Обратное: «квартира» и «жильё» для слов — разные слова, для вектора — одно.
//
// Ни один не заменяет другой, поэтому оба, а места в выдачах складываем по RRF: сами
// оценки в разных шкалах (косинус ~0.4–0.7 против ts_rank ~0.01–0.1) и несравнимы.
const RRF_K = 60; // сглаживание: без него первое место давило бы всё остальное
const SIM_FLOOR = 0.45; // ниже — посторонний кусок (замер: «породы собак» дали 0.412)
const TOP_K = 5;

/**
 * Слова запроса через ИЛИ. plainto_tsquery соединяет через И — «заберут И квартир И
 * банкротств» не находит ничего, что на замере и вышло: текстовый поиск молчал всегда.
 */
function tsQuery(q) {
  const words = String(q || "")
    .toLowerCase()
    .replace(/[^\wа-яё\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  return words.length ? words.join(" | ") : null;
}

/**
 * Куски-опоры под тему. Пусто — значит опоры нет, и это НЕ сбой: это сигнал
 * «не о чем писать честно». Голос (kind='voice') сюда не попадает: свои прошлые посты
 * образец стиля, но не источник фактов — иначе одна выдумка навсегда стала бы «фактом».
 */
async function findSupport(channelId, topic, k = TOP_K) {
  const vec = await embed(topic);
  const tq = tsQuery(topic);
  const rank = new Map();
  const bump = (row, i) => {
    const e = rank.get(row.id) || { ...row, score: 0 };
    e.score += 1 / (RRF_K + i + 1);
    rank.set(row.id, e);
  };

  let bestSim = 0;
  if (vec) {
    const dense = await pool.query(
      `select id, text, kind, source_id, 1 - (embedding <=> $1::vector) as sim
         from knowledge_chunks
        where channel_id = $2 and kind <> 'voice' and embedding is not null
          and (valid_until is null or valid_until >= current_date)
        order by embedding <=> $1::vector limit $3`,
      [toVector(vec), channelId, k],
    );
    // Порог — только на ЛУЧШЕМ векторном совпадении: он решает «есть ли тут вообще о чём».
    // Внутри выдачи порог не применяем — на замере верный кусок был вторым с 0.513 при
    // первом 0.539, разброс меньше шума. Ранжировать топ-5 бессмысленно, показываем все.
    bestSim = Number(dense.rows[0]?.sim || 0);
    dense.rows.forEach(bump);
  }
  if (tq) {
    const words = await pool.query(
      `select id, text, kind, source_id, 0 as sim
         from knowledge_chunks
        where channel_id = $1 and kind <> 'voice' and tsv @@ to_tsquery('russian', $2)
          and (valid_until is null or valid_until >= current_date)
        order by ts_rank(tsv, to_tsquery('russian', $2)) desc limit $3`,
      [channelId, tq, k],
    );
    words.rows.forEach(bump);
    // Точное попадание по словам — самостоятельная опора, даже если вектор промолчал:
    // ровно случай «статья 446 ГПК» (вектор 0.395, слова — в точку).
    if (words.rowCount) bestSim = Math.max(bestSim, SIM_FLOOR);
  }

  if (bestSim < SIM_FLOOR) return [];
  return [...rank.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/**
 * Проиндексировать источник: нарезать и посчитать векторы.
 * Идемпотентно — старые куски источника сносим, иначе правка текста плодила бы дубли,
 * и поиск возвращал бы одно и то же по два раза.
 */
async function indexSource(sourceId) {
  const src = (
    await pool.query(
      `select id, user_id, channel_id, kind, title, raw_text from knowledge_sources where id = $1`,
      [sourceId],
    )
  ).rows[0];
  if (!src) return { error: "no_source" };

  const parts = splitChunks(src.raw_text);
  if (!parts.length) {
    await pool.query(
      `update knowledge_sources set status = 'error', last_error = 'пустой текст' where id = $1`,
      [sourceId],
    );
    return { error: "empty" };
  }

  // Тип куска наследуется от источника: посты канала — это ГОЛОС (образец стиля), и
  // фактом служить не могут. Иначе ИИ начнёт «опираться» на собственную прошлую выдумку
  // и закольцует враньё: один раз соврал — навсегда стало «фактом из базы».
  const kind = src.kind === "channel" ? "voice" : src.kind === "form" ? "service" : "fact";

  const vectors = [];
  for (const part of parts) {
    const v = await embed(part);
    if (!v) {
      // Движок недоступен — оставляем pending и выходим.Наполовину проиндексированный источник
      // хуже непроиндексированного: часть фактов молча пропала бы из поиска.
      await pool.query(
        `update knowledge_sources set status = 'pending', last_error = 'движок ИИ недоступен' where id = $1`,
        [sourceId],
      );
      console.log(`[база] источник ${sourceId}: движок недоступен — жду`);
      return { error: "ai_unavailable" };
    }
    vectors.push([part, v]);
  }

  const tx = await pool.connect();
  try {
    await tx.query("begin");
    await tx.query(`delete from knowledge_chunks where source_id = $1`, [sourceId]);
    for (const [text, v] of vectors) {
      await tx.query(
        `insert into knowledge_chunks (user_id, channel_id, source_id, kind, text, embedding)
         values ($1, $2, $3, $4, $5, $6)`,
        [src.user_id, src.channel_id, sourceId, kind, text, toVector(v)],
      );
    }
    await tx.query(
      `update knowledge_sources set status = 'ready', last_error = null, indexed_at = now() where id = $1`,
      [sourceId],
    );
    await tx.query("commit");
  } catch (err) {
    await tx.query("rollback").catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
  console.log(`[база] «${src.title}» (канал ${src.channel_id}): ${vectors.length} кусков`);
  return { chunks: vectors.length };
}

// Настроения агента — компактная копия src/lib/moods.ts (воркер не может импортировать TS).
// ВАЖНО: держать в синхроне с moods.ts (ключи, тексты, температуры).
const MOODS_W = {
  friendly: { p: "Тёплый профиль: понятно, бережно и без дистанции; без сюсюканья, фамильярности и искусственной заботы.", t: 0.58 },
  cheerful: { p: "Энергичный профиль: активные глаголы и быстрый ритм; без капслока, каскада восклицаний и неуместного восторга.", t: 0.66 },
  expert: { p: "Экспертный профиль: ясный тезис, логика и практическая польза; без канцелярита и неподтверждённой уверенности.", t: 0.42 },
  bold: { p: "Дерзкий профиль: ясная позиция и точный контраст; без хамства, мата, кликбейта и провокации ради провокации.", t: 0.7 },
  inspiring: { p: "Вдохновляющий профиль: реалистичная возможность и конкретный первый шаг; без пустых лозунгов и обещаний лёгкого успеха.", t: 0.62 },
  ironic: { p: "Ироничный профиль: одно-два точных наблюдения, которые усиливают мысль; не шутить над читателем или чужой болью.", t: 0.68 },
  calm: { p: "Спокойный профиль: последовательный и уверенный тон; без давления на страх, надрыва и ложной срочности.", t: 0.4 },
};
const DEFAULT_MOOD_W = "expert";
const moodKeysW = (value) => {
  let raw = [value];
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      raw = Array.isArray(parsed) ? parsed : [];
    } catch {
      raw = [];
    }
  }
  const unique = [...new Set(raw.filter((key) => typeof key === "string" && MOODS_W[key]))].slice(0, 3);
  return unique.length ? unique : [DEFAULT_MOOD_W];
};
const moodPromptW = (value) => {
  const keys = moodKeysW(value);
  const profiles = keys.map((key) => MOODS_W[key]);
  const mix = keys.length > 1 ? `Связка из ${keys.length} профилей — сочетай их одновременно. ` : "";
  return mix + profiles.map((profile) => profile.p).join(" ");
};
const moodTempW = (value) => {
  const profiles = moodKeysW(value).map((key) => MOODS_W[key]);
  return profiles.reduce((sum, profile) => sum + profile.t, 0) / profiles.length;
};
async function userMood(userId) {
  try {
    return (await pool.query("select ai_mood from users where id = $1", [userId])).rows[0]?.ai_mood || null;
  } catch {
    return null;
  }
}

if (!DATABASE_URL) {
  console.error("[worker] нет DATABASE_URL — публиковать некуда");
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1)/.test(DATABASE_URL);
// SSL: по умолчанию проверяем сертификат хоста (защита от MITM). Аварийный выход —
// PGSSL_REJECT_UNAUTHORIZED=false, если cert-chain хоста не доверен Node. Neon использует
// сертификаты Amazon Trust Services/Let's Encrypt (в стандартном CA-бандле), так что true работает.
const sslRejectUnauthorized = process.env.PGSSL_REJECT_UNAUTHORIZED !== "false";
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: sslRejectUnauthorized },
});
// Облачный Postgres рвёт простаивающие соединения. Без этого слушателя обрыв idle-клиента
// = uncaught exception = падение всего воркера. Логируем — пул переподключится сам (ревью).
pool.on("error", (err) =>
  console.error("[worker] простаивающий pg-клиент отвалился (пул переподключится):", err?.message || err),
);

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue("publish", { connection }); // для повторных задач

// ── Медиагенерация NavyAI ───────────────────────────────────────────────────
// Видео нельзя держать внутри HTTP-запроса Next: Veo работает до 10 минут. Отдельная
// durable-очередь переживает закрытую вкладку и рестарт веб-процесса.
const NAVYAI_KEY = process.env.NAVYAI_API_KEY || "";
const NAVYAI_URL = (process.env.NAVYAI_API_URL || "https://api.navy/v1").replace(/\/+$/, "");
const MEDIA_IMAGE_MAX_BYTES = Number(process.env.MEDIA_IMAGE_MAX_BYTES || 25 * 1024 * 1024);
const MEDIA_VIDEO_MAX_BYTES = Number(process.env.MEDIA_VIDEO_MAX_BYTES || 180 * 1024 * 1024);

class MediaGenerationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function mediaJson(url, options, timeoutMs) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${NAVYAI_KEY}`,
      ...(options?.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

function navyError(data, fallback) {
  const raw = String(data?.error?.message || data?.message || fallback || "NavyAI не ответил");
  return raw.replace(/sk-[a-z0-9_-]+/gi, "[ключ скрыт]").slice(0, 300);
}

async function downloadMedia(urlValue, kind) {
  const url = assertSafeMediaUrl(urlValue);
  const maxBytes = kind === "video" ? MEDIA_VIDEO_MAX_BYTES : MEDIA_IMAGE_MAX_BYTES;
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: "follow" });
  if (!res.ok || !res.body) throw new MediaGenerationError("download_failed", "Не удалось сохранить готовый файл.");
  assertSafeMediaUrl(res.url);
  const announced = Number(res.headers.get("content-length") || 0);
  if (announced > maxBytes) throw new MediaGenerationError("file_too_large", "Готовый файл превышает лимит платформы.");

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new MediaGenerationError("file_too_large", "Готовый файл превышает лимит платформы.");
    }
    chunks.push(Buffer.from(value));
  }
  const buffer = Buffer.concat(chunks, total);
  const mime = detectMediaMime(buffer, res.headers.get("content-type"), kind);
  return { buffer, mime };
}

async function persistMediaResult(generation, outputUrl) {
  await pool.query(`update media_generations set status = 'saving', updated_at = now() where id = $1`, [generation.id]);
  const { buffer, mime } = await downloadMedia(outputUrl, generation.kind);
  const ext = mime === "video/mp4" ? "mp4" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const locked = (
      await tx.query(`select output_asset_id, status from media_generations where id = $1 for update`, [generation.id])
    ).rows[0];
    if (!locked || locked.output_asset_id || locked.status === "ready") {
      await tx.query("rollback");
      return;
    }
    const asset = await tx.query(
      `insert into media_assets
        (user_id, kind, file_name, mime_type, bytes, data, sha256, duration_seconds)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [
        generation.user_id,
        generation.kind,
        `aurora-${generation.kind}-${generation.id}.${ext}`,
        mime,
        buffer.byteLength,
        buffer,
        sha256,
        generation.kind === "video" ? generation.seconds : null,
      ],
    );
    await tx.query(
      `update media_generations
          set status = 'ready', output_asset_id = $2, error_code = null, error_message = null,
              updated_at = now(), completed_at = now()
        where id = $1`,
      [generation.id, asset.rows[0].id],
    );
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

async function runMediaGeneration(generationId) {
  if (!NAVYAI_KEY) throw new MediaGenerationError("not_configured", "NavyAI не подключён на сервере.");
  const generation = (
    await pool.query(
      `select id, user_id, kind, status, prompt, negative_prompt, model, aspect_ratio,
              quality, seconds, style, niche, tone, provider_job_id, output_asset_id
         from media_generations where id = $1`,
      [generationId],
    )
  ).rows[0];
  if (!generation || generation.status === "ready" || generation.output_asset_id) return;

  await pool.query(
    `update media_generations set status = 'submitting', error_code = null,
            error_message = null, updated_at = now() where id = $1`,
    [generation.id],
  );
  const payload = buildNavyMediaPayload(generation);
  const created = await mediaJson(
    `${NAVYAI_URL}/images/generations`,
    { method: "POST", body: JSON.stringify(payload) },
    180_000,
  );
  if (!created.res.ok) {
    throw new MediaGenerationError(
      created.res.status === 429 ? "rate_limited" : "provider_error",
      created.res.status === 429
        ? "NavyAI временно ограничил генерации. Попробуй позже."
        : navyError(created.data, `NavyAI вернул ${created.res.status}`),
    );
  }

  const inlineUrl = created.data?.data?.[0]?.url || created.data?.result?.data?.[0]?.url;
  if (inlineUrl) return persistMediaResult(generation, inlineUrl);

  const providerJobId = String(created.data?.id || "");
  if (!providerJobId) throw new MediaGenerationError("bad_provider_response", "NavyAI не вернул идентификатор генерации.");
  await pool.query(
    `update media_generations set status = 'generating', provider_job_id = $2, updated_at = now() where id = $1`,
    [generation.id, providerJobId],
  );

  const deadline = Date.now() + 9 * 60_000;
  while (Date.now() < deadline) {
    await sleep(4_000);
    let polled;
    try {
      polled = await mediaJson(
        `${NAVYAI_URL}/images/generations/${encodeURIComponent(providerJobId)}`,
        { method: "GET" },
        30_000,
      );
    } catch (error) {
      if (Date.now() + 5_000 < deadline) continue;
      throw error;
    }
    if (polled.res.status === 429 || polled.res.status >= 500) continue;
    if (!polled.res.ok) {
      throw new MediaGenerationError("poll_failed", navyError(polled.data, "Не удалось получить результат NavyAI."));
    }
    const status = polled.data?.status;
    if (status === "failed") {
      throw new MediaGenerationError("provider_failed", navyError(polled.data, "Модель не смогла создать файл."));
    }
    if (status === "completed") {
      const outputUrl = polled.data?.result?.data?.[0]?.url || polled.data?.data?.[0]?.url;
      if (!outputUrl) throw new MediaGenerationError("empty_result", "Генерация завершилась без файла.");
      return persistMediaResult(generation, outputUrl);
    }
  }
  throw new MediaGenerationError("timed_out", "Генерация заняла слишком много времени. Попробуй ещё раз позже.");
}

const mediaWorker = AUTOPILOT_ONLY ? null : new Worker(
  MEDIA_QUEUE,
  async (job) => {
    const generationId = Number(job.data.generationId);
    if (!Number.isInteger(generationId) || generationId <= 0) throw new Error("media: bad generation id");
    try {
      await runMediaGeneration(generationId);
    } catch (error) {
      const code = error?.code || "worker_failed";
      const message = String(error?.message || "Не удалось создать медиафайл.").slice(0, 300);
      await pool.query(
        `update media_generations set status = 'failed', error_code = $2, error_message = $3,
                updated_at = now(), completed_at = now()
          where id = $1 and status <> 'ready'`,
        [generationId, code, message],
      );
      throw error;
    }
  },
  { connection, concurrency: 1 },
);
mediaWorker?.on("ready", () => console.log("[media] очередь изображений и видео слушается"));
mediaWorker?.on("failed", (job, error) =>
  console.error(`[media] генерация ${job?.data?.generationId || job?.id} упала:`, error?.message),
);

// Задержки между попытками. По умолчанию 1 / 5 / 15 минут (ТЗ 5.3).
// Для локального теста можно ускорить: RETRY_DELAYS_MS=4000,8000,12000
const RETRY_DELAYS_MS = (process.env.RETRY_DELAYS_MS || "60000,300000,900000")
  .split(",")
  .map(Number);
const MAX_ATTEMPTS = 3;

/** Вызов Bot API. Одна дверь наружу — таймаут и разбор ответа в одном месте. */
async function tg(method, body, timeoutMs = 20_000) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs), // без таймаута зависший запрос блокирует очередь (ревью)
    body: JSON.stringify(body),
  });
  return r.json();
}

async function tgSend(chatId, text, buttons) {
  return tg("sendMessage", {
    chat_id: chatId,
    text: toTelegramHtml(text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard(buttons),
  }); // { ok, result: { message_id }, description }
}

async function tgSendAsset(chatId, asset, text) {
  const isVideo = asset.kind === "video";
  const method = isVideo ? "sendVideo" : "sendPhoto";
  const field = isVideo ? "video" : "photo";
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set(field, new Blob([asset.data], { type: asset.mime_type }), asset.file_name);
  const formatted = formatPost(text);
  const captionFits = formatted.length <= 900;
  if (captionFits) {
    form.set("caption", toTelegramHtml(formatted));
    form.set("parse_mode", "HTML");
  }
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(isVideo ? 120_000 : 60_000),
  });
  const uploaded = await response.json().catch(() => ({ ok: false, description: "Telegram не принял файл" }));
  if (!uploaded.ok || captionFits) return uploaded;
  // У Telegram подпись ограничена 1024 символами. Длинный текст отправляем следом,
  // но только после успешной загрузки медиа.
  return tgSend(chatId, formatted);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------------
// VK API (эгресс воркера). Мелкий сетевой хелпер сознательно дублирует src/lib/vk.ts —
// воркер не импортирует TS (как tg() выше продублирован между воркером и роутами).
// Крипто при этом НЕ дублируем: decryptToken импортирован из общего модуля.
const VK_API_VERSION = "5.199";
async function vkApi(method, params, token, timeoutMs = 20_000) {
  const body = new URLSearchParams({ v: VK_API_VERSION, access_token: token });
  for (const [k, val] of Object.entries(params)) body.set(k, String(val));
  const r = await fetch(`https://api.vk.com/method/${method}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return r.json();
}

const vkPostUrl = (groupId, postId) => `https://vk.com/wall-${groupId}_${postId}`;

/** Публикация записи от имени сообщества VK. */
async function vkWallPost(token, groupId, message) {
  const d = await vkApi("wall.post", { owner_id: `-${groupId}`, from_group: 1, message }, token);
  if (d.error) return { ok: false, errorMsg: d.error.error_msg || "VK error" };
  if (typeof d.response?.post_id === "number") return { ok: true, postId: d.response.post_id };
  return { ok: false, errorMsg: "VK не вернул post_id" };
}

/** Подписчики сообщества VK (groups.getById, fields=members_count). */
async function vkMembersCount(token, groupId) {
  const d = await vkApi(
    "groups.getById",
    { group_id: String(groupId), fields: "members_count" },
    token,
  );
  if (d.error) return null;
  // Ответ менялся между версиями API: то массив, то { groups: [...] }.
  const list = Array.isArray(d.response) ? d.response : d.response?.groups;
  const g = Array.isArray(list) ? list[0] : null;
  return typeof g?.members_count === "number" ? g.members_count : null;
}

/** Метрики поста VK (wall.getById): просмотры/лайки/репосты/комментарии. */
async function vkPostStats(token, groupId, postId) {
  const d = await vkApi("wall.getById", { posts: `-${groupId}_${postId}` }, token);
  if (d.error || !Array.isArray(d.response)) return null;
  const p = d.response[0];
  if (!p) return null;
  const num = (v) => (typeof v?.count === "number" ? v.count : null);
  return {
    views: num(p.views),
    reactions: num(p.likes), // лайки — ближайший аналог реакций TG
    reposts: num(p.reposts),
    comments: num(p.comments),
  };
}

// Паблишинг по сетям с НОРМАЛИЗОВАННЫМ результатом, чтобы успех/сбой/повторы были общими:
//   { ok: true, externalId, postUrl } | { ok: false, reason }

/** Telegram: текущий путь tgSend, без изменений логики. Текст прогоняем через
 * форматтер-гарант: даже если ИИ или человек дал «простыню», в канал уйдёт структура. */
async function publishTg(channel, text, media) {
  let res;
  try {
    const assetId = Number(media?.assetId);
    const asset = Number.isInteger(assetId) && assetId > 0
      ? (
          await pool.query(
            `select kind, file_name, mime_type, data from media_assets where id = $1 and user_id = $2`,
            [assetId, channel.user_id],
          )
        ).rows[0]
      : null;
    res = asset
      ? await tgSendAsset(channel.tg_chat_id, asset, text)
      : await tgSend(channel.tg_chat_id, formatPost(text));
  } catch (err) {
    res = { ok: false, description: String(err?.message || err) };
  }
  if (!res.ok) return { ok: false, reason: res.description };
  const messageId = res.result.message_id;
  // Ссылка только у публичного канала: у приватного t.me/<handle>/<id> ведёт в никуда.
  const postUrl = channel.handle ? `https://t.me/${channel.handle}/${messageId}` : null;
  return { ok: true, externalId: messageId, postUrl };
}

/** VK: расшифровываем токен сообщества (привязка к владельцу) и публикуем на стену. */
async function publishVk(channel, text) {
  let token;
  try {
    token = decryptToken(channel.vk_token, { userId: channel.user_id, provider: "vk" });
  } catch {
    return { ok: false, reason: "не удалось расшифровать токен VK — переподключи сообщество" };
  }
  try {
    const res = await vkWallPost(token, channel.vk_group_id, formatPost(text));
    if (!res.ok) return { ok: false, reason: res.errorMsg };
    return { ok: true, externalId: res.postId, postUrl: vkPostUrl(channel.vk_group_id, res.postId) };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

// ----------------------------------------------------------------------------
// OAuth-сети (YouTube, Instagram, ...). Токен лежит в oauth_tokens (AES-GCM), а не в
// channels. access_token короткий — при истечении/401 обновляем по refresh_token и
// сохраняем обратно, чтобы следующая публикация не споткнулась. Адаптер публикации
// берём из реестра social-providers.mjs — воркер провайдеров не знает.

/** Читает и расшифровывает активный OAuth-токен канала. null — токена нет/не расшифровался. */
async function loadOAuthToken(channel) {
  if (!channel.oauth_token_id) return null;
  const row = (await pool.query(
    `select access_token, refresh_token, expires_at, external_id
       from oauth_tokens where id = $1 and is_active`,
    [channel.oauth_token_id],
  )).rows[0];
  if (!row) return null;
  const ctx = { userId: channel.user_id, provider: channel.network };
  try {
    return {
      tokenId: channel.oauth_token_id,
      externalId: row.external_id,
      accessToken: decryptToken(row.access_token, ctx),
      refreshToken: row.refresh_token ? decryptToken(row.refresh_token, ctx) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    };
  } catch {
    return null;
  }
}

/** Обновляет access_token по refresh_token и сохраняет новый конверт в oauth_tokens. */
async function refreshOAuthToken(channel, tok) {
  const cfg = getOAuthConfig(channel.network);
  if (!cfg || !tok.refreshToken) return null;
  try {
    const fresh = await refreshAccessToken(cfg, tok.refreshToken);
    if (!fresh.accessToken) return null;
    const ctx = { userId: channel.user_id, provider: channel.network };
    const accessEnc = encryptToken(fresh.accessToken, ctx);
    const refreshEnc = fresh.refreshToken
      ? encryptToken(fresh.refreshToken, ctx)
      : tok.refreshToken
        ? encryptToken(tok.refreshToken, ctx)
        : null;
    const expiresAt = fresh.expiresIn ? new Date(Date.now() + fresh.expiresIn * 1000) : null;
    await pool.query(
      `update oauth_tokens set access_token = $2, refresh_token = $3, expires_at = $4, updated_at = now()
        where id = $1`,
      [tok.tokenId, accessEnc, refreshEnc, expiresAt],
    );
    return { ...tok, accessToken: fresh.accessToken, expiresAt };
  } catch (err) {
    console.warn(`[worker] не удалось обновить токен ${channel.network}:`, err?.message || err);
    return null;
  }
}

/**
 * Публикация в OAuth-сеть через адаптер реестра. Нормализованный результат — как у TG/VK:
 *   { ok: true, externalId, postUrl } | { ok: false, reason }
 * payload: { text, media, title, privacyStatus }.
 */
async function publishOAuth(channel, payload) {
  const adapter = getAdapter(channel.network);
  if (!adapter) return { ok: false, reason: `сеть ${channel.network} не поддерживается` };

  let tok = await loadOAuthToken(channel);
  if (!tok) return { ok: false, reason: "нет токена — переподключи канал" };

  // Токен на исходе (<5 мин) — обновляем заранее, чтобы не получить 401 на публикации.
  if (tok.expiresAt && tok.expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    tok = (await refreshOAuthToken(channel, tok)) || tok;
  }

  let res = await adapter.publish(tok.accessToken, payload, tok.externalId);

  // 401/протухший токен — один раз обновляем и повторяем.
  if (!res.ok && /401|invalid.*(token|grant)|expired/i.test(res.reason || "")) {
    const fresh = await refreshOAuthToken(channel, tok);
    if (fresh) {
      tok = fresh;
      res = await adapter.publish(tok.accessToken, payload, tok.externalId);
    }
  }
  return res;
}

const RECON_CONCURRENCY = 6; // скромно, чтобы самим не провоцировать 429 у t.me
// Генерация поста — тяжёлый ИИ-вызов (~90с), а не лёгкий HTML-запрос. Провайдер/локальная Ollama
// не бесконечны, поэтому лимит ниже разведочного: режем 45-минутную сборку плана примерно втрое,
// не долбя движок десятком одновременных запросов.
// Облачный API выдерживает параллельные вызовы; локальный Ollama с одной 8B-моделью — нет.
// Три одновременных запроса ставили друг друга в очередь и ловили 90-секундные таймауты,
// после чего в плане появлялись пустые карточки. Локально пишем последовательно.
const AUTOPILOT_CONCURRENCY = CLOUD_KEY ? 3 : 1;

// t.me/s/ — единственный источник данных разведки, и он легко отдаёт 429, если долбить часто.
// Раньше 429 молча ронял сбор (r.ok = false → пустой результат, данные пропадали до след. цикла).
// Теперь при 429 читаем Retry-After, ждём и повторяем; при сетевой ошибке — экспоненциальный
// бэкофф. Не-429 ответы (включая 404) возвращаем как есть — вызывающий код сам проверяет r.ok.
const TG_FETCH_ATTEMPTS = 3;
async function fetchTgWithBackoff(url) {
  let delay = 2000;
  for (let attempt = 1; attempt <= TG_FETCH_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (attempt === TG_FETCH_ATTEMPTS) throw err;
      console.warn(`[recon] сеть: ${err?.message}; повтор через ${Math.round(delay / 1000)}с (попытка ${attempt})`);
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || delay;
      if (attempt === TG_FETCH_ATTEMPTS) {
        console.warn(`[recon] 429 от t.me, попытки исчерпаны — отдаю 429 вызывающему коду`);
        return res; // r.ok = false → вызывающий обработает как пустой результат
      }
      console.warn(`[recon] 429 от t.me, ждём ${Math.round(wait / 1000)}с (попытка ${attempt})`);
      await sleep(wait);
      delay *= 2;
      continue;
    }
    return res;
  }
}

// Честная доставка (надёжность из ТЗ): возвращаем true ТОЛЬКО если Telegram реально
// принял сообщение (ok:true). При сбое сети или ok:false — повторяем несколько раз с
// паузой; если так и не ушло — честно логируем ошибку и возвращаем false.
// Никогда не бросаем: уведомление не должно ронять обработку задачи.
//
// ВАЖНО (ревью безопасности): сюда шлём ТОЛЬКО события платформы как целого — недельный
// отчёт владельца и сбой публикации при перезапуске сервера. События конкретного
// пользователя (его пост вышел/упал, залёт конкурента, готовый план) сюда НЕ пересылаем:
// раньше при непривязанном чате они светились в чате владельца — это была утечка.
async function notifyOwner(text) {
  if (!TOKEN || !OWNER_CHAT) return false;
  const delays = [0, 1500, 5000]; // 3 попытки с нарастающей паузой
  let lastErr = "";
  for (let attempt = 1; attempt <= delays.length; attempt++) {
    if (delays[attempt - 1]) await sleep(delays[attempt - 1]);
    try {
      const res = await tgSend(OWNER_CHAT, text);
      if (res && res.ok) return true;
      lastErr = (res && res.description) || "Telegram вернул ok:false";
    } catch (err) {
      lastErr = String(err?.message || err);
    }
    console.warn(`[notify] попытка ${attempt}/${delays.length} не удалась: ${lastErr}`);
  }
  console.error(`[notify] уведомление НЕ доставлено (${delays.length} попыток): ${lastErr}`);
  return false;
}

/**
 * Уведомление КОНКРЕТНОМУ пользователю в его личный чат с ботом.
 * Раньше всё уходило в TG_CHAT_ID — один чат владельца: второй пользователь не получал
 * ничего, а его события приходили владельцу. Теперь адрес берём из users.tg_chat_id,
 * который проставляется, когда человек сам нажал /start по ссылке привязки.
 * Не привязан — молча пропускаем: слать некуда, и это не ошибка.
 */
async function notifyUser(userId, text, buttons) {
  try {
    const chat = (await pool.query(`select tg_chat_id from users where id = $1`, [userId])).rows[0]
      ?.tg_chat_id;
    if (!chat) return false;
    const res = await tgSend(chat, text, buttons);
    if (res?.ok) return true;
    // 403 = человек заблокировал бота. Забываем чат, иначе будем долбиться в стену вечно.
    if (/bot was blocked|user is deactivated|chat not found/i.test(res?.description || "")) {
      await pool.query(`update users set tg_chat_id = null where id = $1`, [userId]);
      console.warn(`[bot] user ${userId} заблокировал бота — отвязал`);
    } else {
      console.error(`[bot] не доставлено user ${userId}:`, res?.description);
    }
    return false;
  } catch (err) {
    console.error(`[bot] ошибка отправки user ${userId}:`, err?.message);
    return false;
  }
}

// ── Gap-доспрос: ИИ спрашивает человека, когда упрёлся в пробел знаний ─────────────
// Антивранье работает в обе стороны: база знаний отвечает на вопрос «что писать»,
// а когда факта НЕТ (цифру пришлось убрать из поста, база пуста) — ИИ не выдумывает,
// а спрашивает у человека в боте. Ответ уходит в knowledge_sources kind='form'.
//
// Антиспам жёсткий: та же тема не переспрашивается 14 дней (даже если проигнорил),
// и одновременно висит не больше одного вопроса — ИИ не превращается в интервьюера.
async function maybeAskGap(userId, channelId, topic, question) {
  try {
    const dup = await pool.query(
      `select 1 from gap_questions where user_id = $1 and topic = $2
         and created_at > now() - interval '14 days' limit 1`,
      [userId, topic],
    );
    if (dup.rowCount) return false;
    const pending = await pool.query(
      `select 1 from gap_questions where user_id = $1 and status = 'pending' limit 1`,
      [userId],
    );
    if (pending.rowCount) return false;

    const ins = await pool.query(
      `insert into gap_questions (user_id, channel_id, topic, question) values ($1, $2, $3, $4)
       returning id`,
      [userId, channelId, topic, question],
    );
    const id = Number(ins.rows[0].id);
    const sent = await notifyUser(userId, `🧠 ${question}`, [
      [{ text: "Отвечу позже", data: `gap:skip:${id}` }],
    ]);
    if (!sent) {
      // Бот не привязан — вопрос не должен висеть pending вечно (блокировал бы следующие).
      await pool.query(`update gap_questions set status = 'skipped' where id = $1`, [id]);
      return false;
    }
    console.log(`[gap] user ${userId}: спросил «${topic}»`);
    return true;
  } catch (err) {
    console.error(`[gap] user ${userId}:`, err?.message);
    return false;
  }
}

/** Самый старый висящий gap-вопрос человека. Их не бывает больше одного — см. maybeAskGap. */
async function pendingGap(userId) {
  return (
    (
      await pool.query(
        `select id, channel_id, topic, question from gap_questions
          where user_id = $1 and status = 'pending'
          order by created_at asc limit 1`,
        [userId],
      )
    ).rows[0] || null
  );
}

/**
 * Ответ человека на gap-вопрос → источник базы знаний. Кладём kind='form': индексатор
 * пометит куски как 'service', и страж фактов разрешит ИИ на них опираться.
 * Индексируем сразу, минуя очередь: человек ждёт, что следующий пост уже учтёт ответ.
 */
async function saveGapAnswer(userId, q, text) {
  const ins = await pool.query(
    `insert into knowledge_sources (user_id, channel_id, kind, title, raw_text)
     values ($1, $2, 'form', $3, $4) returning id`,
    [userId, q.channel_id, `Ответ в боте: ${q.topic}`, `Вопрос: ${q.question}\n\nОтвет: ${text}`],
  );
  await indexSource(Number(ins.rows[0].id));
  await pool.query(
    `update gap_questions set status = 'answered', answer = $2, answered_at = now() where id = $1`,
    [q.id, text.slice(0, 4000)],
  );
  console.log(`[gap] user ${userId}: ответ на «${q.topic}» ушёл в базу`);
}

const worker = AUTOPILOT_ONLY || MEDIA_ONLY ? null : new Worker(
  "publish",
  async (job) => {
    const postId = job.data.postId;

    // Заявляем пост атомарно: публикуем ТОЛЬКО если он ещё scheduled.
    // Так пост никогда не выйдет дважды — даже если задача продублировалась.
    const claim = await pool.query(
      `update posts set status = 'publishing'
       where id = $1 and status = 'scheduled'
       returning id, user_id, channel_id, text, media, attempts`,
      [postId],
    );
    if (claim.rowCount === 0) {
      console.log(`[worker] пост ${postId} уже обработан или не ждёт публикации — пропускаю`);
      return;
    }
    const post = claim.rows[0];

    const ch = await pool.query(
      `select user_id, network, tg_chat_id, vk_group_id, vk_token, oauth_token_id,
              instagram_account_id, title, handle
         from channels where id = $1`,
      [post.channel_id],
    );
    const channel = ch.rows[0];

    // Канал подключён? Для каждой сети свой обязательный набор полей.
    // OAuth-сети (youtube/instagram/...) публикуют через oauth_tokens — нужен oauth_token_id.
    const OAUTH_NETWORKS = ["youtube", "instagram", "x", "tiktok", "linkedin"];
    const connected =
      channel?.network === "vk"
        ? !!(channel.vk_group_id && channel.vk_token)
        : OAUTH_NETWORKS.includes(channel?.network)
          ? !!channel?.oauth_token_id
          : !!channel?.tg_chat_id;
    if (!connected) {
      await pool.query(`update posts set status = 'failed', last_error = $2 where id = $1`, [
        postId,
        "канал не подключён",
      ]);
      return;
    }

    // Публикуем по сети; результат нормализован (publishTg/publishVk/publishOAuth).
    let out;
    if (channel.network === "vk") {
      out = await publishVk(channel, post.text);
    } else if (OAUTH_NETWORKS.includes(channel.network)) {
      // media — jsonb: объект или null. Для видео (YouTube/Reels) нужен источник файла.
      const media = post.media && typeof post.media === "object" ? post.media : null;
      const firstLine = String(post.text || "").split("\n")[0].trim();
      out = await publishOAuth(channel, {
        text: post.text,
        media,
        title: media?.title || firstLine.slice(0, 100) || "Видео из Авроры",
        privacyStatus: media?.privacyStatus || "private",
      });
    } else {
      out = await publishTg(channel, post.text, post.media);
    }

    // --- Успех ---
    if (out.ok) {
      // id вышедшей записи кладём в колонку своей сети: tg_message_id / vk_post_id /
      // external_post_id (универсальная для OAuth-сетей).
      const idCol =
        channel.network === "vk"
          ? "vk_post_id"
          : OAUTH_NETWORKS.includes(channel.network)
            ? "external_post_id"
            : "tg_message_id";
      await pool.query(
        `update posts set status = 'published', ${idCol} = $2, published_at = now(),
                          attempts = attempts + 1, last_error = null
         where id = $1`,
        [postId, out.externalId],
      );
      console.log(`[worker] ✅ пост ${postId} вышел (${channel.network} id ${out.externalId})`);
      const okText =
        `✅ Пост вышел${channel.title ? ` в «${channel.title}»` : ""}. Посмотрим, как зайдёт — цифры пришлю позже.`;
      const okBtns = out.postUrl ? [[{ text: "Открыть пост", url: out.postUrl }]] : undefined;
      // Нет привязанного чата — выбор пользователя, владельцу чужой пост не шлём (была утечка).
      await notifyUser(post.user_id, okText, okBtns);
      return;
    }

    // --- Сбой: до 3 автоповторов ---
    const attempts = post.attempts + 1;
    const reason =
      out.reason ||
      (channel.network === "vk"
        ? "VK не ответил"
        : OAUTH_NETWORKS.includes(channel.network)
          ? `${channel.network} не ответил`
          : "Telegram не ответил");

    if (attempts < MAX_ATTEMPTS) {
      await pool.query(
        `update posts set status = 'scheduled', attempts = $2, last_error = $3 where id = $1`,
        [postId, attempts, reason],
      );
      const delay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      await queue.add(
        "publish",
        { postId },
        { delay, jobId: `post-${postId}-retry-${attempts}`, removeOnComplete: true, removeOnFail: false },
      );
      console.log(
        `[worker] ⚠️ пост ${postId} не вышел (${reason}); повтор через ${Math.round(delay / 1000)}с (попытка ${attempts})`,
      );
      // Успокаиваем АВТОРА поста после ПЕРВОГО сбоя — тоном из ТЗ 7.5. Раньше сообщение
      // уходило владельцу: чужой пост и причина сбоя светились в чате платформы (утечка).
      // Нет привязанного чата — notifyUser молча пропустит, это не ошибка.
      if (attempts === 1) {
        const nextMin = Math.max(1, Math.round((RETRY_DELAYS_MS[1] ?? 300000) / 60000));
        await notifyUser(
          post.user_id,
          `⚠️ Пост не ушёл — ${reason}. Пробую ещё раз через ${nextMin} минут, ничего делать не нужно. ` +
            `Если не получится за 3 попытки — скажу.`,
        );
      }
    } else {
      await pool.query(
        `update posts set status = 'failed', attempts = $2, last_error = $3 where id = $1`,
        [postId, attempts, reason],
      );
      console.log(`[worker] ❌ пост ${postId} провалился после ${attempts} попыток (${reason})`);
      // Кнопка вместо «загляни в приложение»: повтор делается прямо из телефона.
      const failText =
        `❌ Пост не вышел за 3 попытки — ${reason}.\n` +
        `Проверь, что бот всё ещё админ канала, и жми «Отправить снова».`;
      const failBtn = [[{ text: "Отправить снова", data: `retry:${postId}` }]];
      // Только автору поста: неудача публикации — событие пользователя, а не платформы.
      // Не привязал чат — его выбор, владельцу чужой пост не пересылаем (была утечка).
      await notifyUser(post.user_id, failText, failBtn);
    }
  },
  { connection },
);

worker?.on("ready", () => console.log("[worker] очередь публикации слушается"));
worker?.on("error", (err) => console.error("[worker] ошибка:", err));
worker?.on("failed", (job, err) =>
  console.error(`[worker] задача ${job?.id} упала:`, err?.message),
);

// ============================================================================
// БОТ: приём команд и кнопок.
//
// Публичный webhook НЕ НУЖЕН: getUpdates с длинным опросом работает откуда угодно, в том
// числе с localhost — проверено. Воркер и так всегда включён, а это ровно то, что нужно
// поллингу. Поэтому интерактивный бот не ждёт домена и деплоя.
//
// ВАЖНО: getUpdates и webhook взаимоисключающи. На деплое ставим TG_WEBHOOK_URL — поллинг
// сам отключится, и приём переедет на webhook без переписывания обработчиков.
// ============================================================================

const BOT_POLL = !AUTOPILOT_ONLY && !MEDIA_ONLY && !process.env.TG_WEBHOOK_URL;

/** Что бот умеет — показывается в меню Telegram по кнопке «/». */
const BOT_COMMANDS = [
  { command: "stats", description: "Цифры канала за неделю" },
  { command: "plan", description: "План недели от автопилота" },
  { command: "trends", description: "Что зашло у конкурентов" },
  { command: "help", description: "Что я умею" },
];

/** Кто написал. null — чат не привязан ни к кому. */
async function userByChat(chatId) {
  return (await pool.query(`select id from users where tg_chat_id = $1`, [chatId])).rows[0]?.id ?? null;
}

/** /start <код> — привязка чата к аккаунту. Код одноразовый и живёт 15 минут. */
async function handleStart(chatId, code) {
  if (!code) {
    await tgSend(
      chatId,
      "Привет. Я присылаю, что происходит с твоим каналом: пост вышел, пост упал, у конкурента залетело.\n\n" +
        "Чтобы я знал, чьи новости слать, — открой «Настройки» в Авроре и нажми «Подключить бота».",
    );
    return;
  }

  const link = (
    await pool.query(
      `update bot_links set used_at = now()
        where code = $1 and used_at is null and expires_at > now()
        returning user_id`,
      [code],
    )
  ).rows[0];

  if (!link) {
    // Не говорим «неверный код» — код мог просто протухнуть, человек не виноват.
    await tgSend(chatId, "Ссылка устарела — они живут 15 минут. Открой «Настройки» в Авроре и нажми «Подключить бота» ещё раз.");
    return;
  }

  // Чат мог быть привязан к другому аккаунту — отвязываем, иначе уведомления раздвоятся.
  await pool.query(`update users set tg_chat_id = null where tg_chat_id = $1`, [chatId]);
  await pool.query(`update users set tg_chat_id = $2 where id = $1`, [link.user_id, chatId]);

  await tgSend(
    chatId,
    "Готово, теперь пишу сюда. Что будет прилетать:\n\n" +
      "• пост вышел или не вышел — сразу, с кнопкой «Отправить снова»\n" +
      "• у конкурента залетело — с кнопкой «Сними это»\n" +
      "• план недели от автопилота — с кнопкой «Одобрить всё»\n\n" +
      "Команды: /stats — цифры, /plan — план недели, /trends — что зашло у соседей.",
  );
  console.log(`[bot] чат ${chatId} привязан к user ${link.user_id}`);
}

/** Ответ на нажатие: Telegram ждёт его в пределах ~10 секунд, иначе кнопка «залипает». */
async function answerCb(id, text) {
  await tg("answerCallbackQuery", { callback_query_id: id, text: text?.slice(0, 200) }, 8000).catch(
    () => {},
  );
}

// ============================================================================
// Д.5 — сбор аналитики. Тот же всегда-включённый воркер.
// Подписчики — Bot API (getChatMemberCount). Просмотры/реакции — публичная
// страница t.me/s/<канал> (Bot API их не отдаёт), только для публичных каналов.
// Чего сеть не отдаёт (охват, комментарии) — оставляем null = «недоступно».
// ============================================================================

// Дата снимка — МОСКОВСКАЯ, а не UTC. Продукт живёт в МСК, а `toISOString()` даёт день по
// Гринвичу: сбор в 01:30 МСК — это ещё 22:30 UTC вчерашних суток, и снимок ложился под
// вчерашнюю дату. Он перезаписывал вчерашний (unique по дате), сегодняшний не появлялся
// вовсе, а прирост считался от позавчера — график роста врал (ревью).
const mskToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });

async function tgMemberCount(chatId) {
  try {
    // POST через единый tg()-эгресс: параметры в теле, а не в query-string
    // (токен и chat_id не оседают в access-логах прокси).
    const d = await tg("getChatMemberCount", { chat_id: chatId }, 15_000);
    return d.ok ? d.result : null;
  } catch {
    return null;
  }
}

// Разбор публичной страницы: { message_id: { views, reactions } }
async function fetchPublicStats(handle) {
  const h = String(handle).replace(/^@/, "");
  const result = {};
  try {
    const r = await fetchTgWithBackoff(`https://t.me/s/${h}`);
    if (!r.ok) return result;
    const html = await r.text();
    const parts = html.split('data-post="');
    for (let i = 1; i < parts.length; i++) {
      const b = parts[i];
      const mid = b.match(/^[^/]+\/(\d+)"/);
      if (!mid) continue;
      const v = b.match(/tgme_widget_message_views">([^<]+)</);
      result[Number(mid[1])] = { views: v ? parseCount(v[1]) : null, reactions: sumReactions(b) };
    }
  } catch (err) {
    console.error("[stats] t.me/s разбор не удался:", err?.message);
  }
  return result;
}

async function collectStats() {
  const today = mskToday();
  const chans = (
    await pool.query(
      `select id, tg_chat_id, handle from channels where network = 'tg' and is_active = true`,
    )
  ).rows;

  await mapConcurrent(chans, RECON_CONCURRENCY, async (ch) => {
    // 1) Подписчики — реальное число + прирост за день.
    const subs = await tgMemberCount(ch.tg_chat_id);
    if (subs != null) {
      const prev = (
        await pool.query(
          `select subscribers from channel_stats where channel_id = $1 and snapshot_date < $2
           order by snapshot_date desc limit 1`,
          [ch.id, today],
        )
      ).rows[0];
      const delta = prev ? subs - prev.subscribers : null;
      await pool.query(
        `insert into channel_stats (channel_id, snapshot_date, subscribers, subscribers_delta)
         values ($1, $2, $3, $4)
         on conflict (channel_id, snapshot_date)
         do update set subscribers = $3, subscribers_delta = $4, collected_at = now()`,
        [ch.id, today, subs, delta],
      );
    }

    // 2) Просмотры/реакции постов — из публичной страницы, по message_id.
    if (ch.handle) {
      const pub = await fetchPublicStats(ch.handle);
      const seen = Object.keys(pub).map(Number);
      // Страница показывает ~20 последних сообщений. Если нашего сообщения на ней нет, но его
      // номер попадает в этот диапазон — сообщение удалено из канала. Если номер меньше
      // самого старого на странице — оно просто вне окна, и это не повод объявлять его мёртвым.
      const oldestSeen = seen.length ? Math.min(...seen) : null;
      const pageOk = seen.length > 0;

      const posts = (
        await pool.query(
          `select id, tg_message_id from posts
           where channel_id = $1 and status = 'published' and tg_message_id is not null`,
          [ch.id],
        )
      ).rows;
      for (const p of posts) {
        const st = pub[p.tg_message_id];
        if (st) {
          await pool.query(
            `insert into post_stats (post_id, snapshot_date, views, reactions)
             values ($1, $2, $3, $4)
             on conflict (post_id, snapshot_date)
             do update set views = $3, reactions = $4, collected_at = now()`,
            [p.id, today, st.views, st.reactions],
          );
          await pool.query(`update posts set stats_state = 'ok' where id = $1`, [p.id]);
          continue;
        }
        // Нет на странице. Отличаем «удалён» от «вне окна» — иначе «недоступно» ничего не значит.
        if (pageOk && Number(p.tg_message_id) >= oldestSeen) {
          await pool.query(`update posts set stats_state = 'gone' where id = $1`, [p.id]);
        } else if (!pageOk) {
          await pool.query(
            `update posts set stats_state = coalesce(stats_state, 'private') where id = $1`,
            [p.id],
          );
        }
      }
    } else {
      // У канала нет публичного адреса — просмотров не будет никогда, так и скажем.
      await pool.query(
        `update posts set stats_state = 'private'
          where channel_id = $1 and status = 'published' and stats_state is null`,
        [ch.id],
      );
    }
  });
  console.log(`[stats] снимок собран за ${today} (каналов: ${chans.length})`);
}

// Суточный снимок аналитики VK-сообществ: подписчики + метрики вышедших постов.
// Идёт тем же кроном «stats» следом за TG. Лимит VK ~3 rps на токен сообщества,
// поэтому конкурентность ниже разведочной.
const VK_CONCURRENCY = 3;
async function collectVkStats() {
  const today = mskToday();
  const chans = (
    await pool.query(
      `select id, user_id, vk_group_id, vk_token from channels where network = 'vk' and is_active = true`,
    )
  ).rows;

  await mapConcurrent(chans, VK_CONCURRENCY, async (ch) => {
    let token;
    try {
      token = decryptToken(ch.vk_token, { userId: ch.user_id, provider: "vk" });
    } catch {
      return; // токен не читается — канал переподключат, снимок просто пропустим
    }

    // 1) Подписчики + прирост за день (логика один в один с TG).
    const subs = await vkMembersCount(token, ch.vk_group_id);
    if (subs != null) {
      const prev = (
        await pool.query(
          `select subscribers from channel_stats where channel_id = $1 and snapshot_date < $2
           order by snapshot_date desc limit 1`,
          [ch.id, today],
        )
      ).rows[0];
      const delta = prev ? subs - prev.subscribers : null;
      await pool.query(
        `insert into channel_stats (channel_id, snapshot_date, subscribers, subscribers_delta)
         values ($1, $2, $3, $4)
         on conflict (channel_id, snapshot_date)
         do update set subscribers = $3, subscribers_delta = $4, collected_at = now()`,
        [ch.id, today, subs, delta],
      );
    }

    // 2) Метрики вышедших постов VK (просмотры/лайки/репосты/комментарии).
    const posts = (
      await pool.query(
        `select id, vk_post_id from posts
         where channel_id = $1 and status = 'published' and vk_post_id is not null`,
        [ch.id],
      )
    ).rows;
    for (const p of posts) {
      const st = await vkPostStats(token, ch.vk_group_id, p.vk_post_id);
      if (!st) continue;
      await pool.query(
        `insert into post_stats (post_id, snapshot_date, views, reactions, reposts, comments)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (post_id, snapshot_date)
         do update set views = $3, reactions = $4, reposts = $5, comments = $6, collected_at = now()`,
        [p.id, today, st.views, st.reactions, st.reposts, st.comments],
      );
      await pool.query(`update posts set stats_state = 'ok' where id = $1`, [p.id]);
    }
  });
  if (chans.length) console.log(`[stats] снимок VK собран за ${today} (сообществ: ${chans.length})`);
}

// ============================================================================
// Д.6 — разведка конкурентов. ТОЛЬКО открытые данные публичного канала:
// getChat (название) + getChatMemberCount (подписчики) + t.me/s/ (посты).
// Закрытых данных не собираем. Тот же всегда-включённый воркер.
// ============================================================================

// Разбор публичной страницы канала: посты (id, текст, время, просмотры, реакции)
// + запасные название/подписчики из шапки.
async function fetchCompetitorPage(handle) {
  const h = String(handle).replace(/^@/, "");
  const out = { ok: false, title: null, subscribers: null, posts: [] };
  try {
    const r = await fetchTgWithBackoff(`https://t.me/s/${h}`);
    if (!r.ok) return out;
    const html = await r.text();

    const subM = html.match(/counter_value">([^<]+)<\/span>\s*<span class="counter_type">subscribers/);
    if (subM) out.subscribers = parseCount(subM[1].replace(/\s/g, ""));
    const titM = html.match(/tgme_channel_info_header_title[^>]*><span[^>]*>([^<]+)/);
    if (titM) out.title = decodeEntities(titM[1]).trim() || null;

    const parts = html.split('data-post="');
    for (let i = 1; i < parts.length; i++) {
      const b = parts[i];
      const midM = b.match(/^[^/]+\/(\d+)"/);
      if (!midM) continue;
      const timeM = b.match(/datetime="([^"]+)"/);
      const viewsM = b.match(/tgme_widget_message_views">([^<]+)</);
      const reactions = sumReactions(b);
      const txtM = b.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
      let text = null;
      if (txtM) {
        text = decodeEntities(txtM[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
        if (!text) text = null;
      }
      // Тип медиа — для медиа-микса в досье (что у конкурента заходит лучше).
      const media = /tgme_widget_message_video/.test(b)
        ? "video"
        : /tgme_widget_message_photo/.test(b)
          ? "photo"
          : "text";
      // Картинка поста для визуальной ленты. Telegram отдаёт её фоном блока, а не <img>.
      // Ссылку можно показывать прямо у себя: cdn telesco.pe отвечает 200 без реферера
      // и с access-control-allow-origin: * — прокси не нужен (проверено).
      const photoM = b.match(/tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/);
      out.posts.push({
        msgId: Number(midM[1]),
        text,
        media,
        photoUrl: photoM ? photoM[1] : null,
        views: viewsM ? parseCount(viewsM[1]) : null,
        reactions,
        postedAt: timeM ? timeM[1] : null,
      });
    }
    out.ok = true;
    return out;
  } catch (err) {
    console.error("[recon] разбор t.me/s не удался:", err?.message);
    return out;
  }
}

// Собрать досье одного конкурента: название + подписчики (Bot API) + посты (страница).
async function collectCompetitor(comp) {
  const ref = "@" + comp.handle;
  let title = null;
  try {
    const gc = await tg("getChat", { chat_id: ref }, 15_000);
    if (gc.ok && gc.result?.type === "channel") title = gc.result.title ?? null;
  } catch {
    /* сеть — возьмём название со страницы */
  }
  let subscribers = await tgMemberCount(ref);

  const page = await fetchCompetitorPage(comp.handle);
  if (title == null) title = page.title;
  if (subscribers == null) subscribers = page.subscribers;

  // Ничего не собралось — канал закрыт/не существует. Честная ошибка в карточку.
  if (!page.ok && title == null && subscribers == null) {
    await pool.query(
      `update competitors set status = 'error', last_error = $2, collected_at = now() where id = $1`,
      [comp.id, "Канал не найден или закрыт — досье собирается только по публичным каналам."],
    );
    console.log(`[recon] @${comp.handle}: закрыт/не найден`);
    return;
  }

  // Канал отвечает, но ленты в нём нет: t.me/s/ отдал только шапку (закрытая лента,
  // «только по приглашению»). Раньше такой канал молча становился 'ready' с нулём постов
  // и выглядел в списке нормальным — врали. Теперь говорим прямо.
  if (page.posts.length === 0) {
    await pool.query(
      `update competitors set title = coalesce($2, title), subscribers = coalesce($3, subscribers),
         status = 'no_feed', last_error = $4, collected_at = now() where id = $1`,
      [
        comp.id,
        title,
        subscribers,
        "Канал не показывает ленту публично — постов не видно. Досье собрать не из чего.",
      ],
    );
    console.log(`[recon] @${comp.handle}: лента закрыта, постов нет`);
    return;
  }

  for (const p of page.posts) {
    await pool.query(
      `insert into competitor_posts (competitor_id, tg_msg_id, text, views, reactions, media, photo_url, posted_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (competitor_id, tg_msg_id) do update set
         text = $3, views = $4, reactions = $5, media = $6,
         photo_url = coalesce($7, competitor_posts.photo_url),
         posted_at = coalesce(competitor_posts.posted_at, $8), collected_at = now()`,
      [comp.id, p.msgId, p.text, p.views, p.reactions, p.media, p.photoUrl, p.postedAt],
    );
  }

  if (subscribers != null) {
    const today = mskToday();
    await pool.query(
      `insert into competitor_stats (competitor_id, snapshot_date, subscribers) values ($1, $2, $3)
       on conflict (competitor_id, snapshot_date) do update set subscribers = $3, collected_at = now()`,
      [comp.id, today, subscribers],
    );
  }

  await pool.query(
    `update competitors set title = coalesce($2, title), subscribers = coalesce($3, subscribers),
       status = 'ready', last_error = null, collected_at = now() where id = $1`,
    [comp.id, title, subscribers],
  );
  console.log(
    `[recon] @${comp.handle}: ${page.posts.length} постов, ${subscribers ?? "?"} подписчиков`,
  );

  // Д.7: сразу после сбора ищем залёты и генерируем идеи.
  await detectHits({ id: comp.id, user_id: comp.user_id, handle: comp.handle, title: title || comp.title }).catch(
    (e) => console.error(`[hits] @${comp.handle}:`, e?.message),
  );
}

// ============================================================================
// Д.6+ — АГЕНТ САМ ИЩЕТ СОСЕДЕЙ ПО НИШЕ.
//
// Почему так, а не «спросить у ИИ»: у Telegram нет поиска каналов, а модель на вопрос
// «назови юридические каналы» выдумает handle'ы, которых не существует. Проверено в этой
// же сессии: hermes3 сочинил категории с несуществующими числами.
//
// Работающий сигнал — граф ниши: каналы ссылаются друг на друга в постах. Идём от своего
// канала и уже добавленных конкурентов, собираем упоминания, каждого кандидата проверяем
// живьём и приносим человеку на подтверждение. Добавляет он, а не мы.
// ============================================================================

// Гигант — не твой конкурент. @kommersant и @bbbreaking упоминают все, но соседями
// по нише они не являются: у них другая лига и другая аудитория.
const DISCOVER_MAX_SUBS = 500_000;
// Сколько кандидатов проверяем за проход: каждая проверка — запрос к t.me, экономим.
const DISCOVER_CHECK_LIMIT = 12;
// Сколько каналов добавляем сами на холодном старте. Три — чтобы лента ожила, но у человека
// осталось место (потолок 20) и ощущение, что список его, а не наш.
const AUTO_ADD_MAX = 3;

const MENTION_STOP = new Set([
  "s", "share", "iv", "joinchat", "addstickers", "addemoji", "proxy", "socks", "c", "setlanguage",
  "telegram", "durov", "contact", "login",
]);

/**
 * «Сосед по нише или просто знакомый?» — решает ИИ, сверяя посты кандидата с БРИФОМ канала.
 *
 * Почему не подсчёт общих слов: пробовал, провалилось. Бриф в аудитории упоминает
 * «разработчиков», а цель — «сообщество, встреча, создание». В итоге софтверный блог совпал
 * по этим словам и занял ПЕРВОЕ место (36.6%), а «AI & Law» — ровно эта ниша — получил 0%.
 * Общая лексика бьёт тему, как и в трендах.
 *
 * Здесь ИИ ничего не выдумывает: канал уже найден в графе и проверен живьём. Модель только
 * читает реальные тексты и отвечает да/нет. Её объяснения при этом врут (проверено — она
 * пересказывает мою же нишу вместо кандидата), поэтому берём вердикт и не показываем причину.
 * Нет движка — возвращаем null: тогда честно покажем кандидата как непроверенного.
 */
async function sameNiche(brief, title, posts) {
  if (!brief?.niche || !posts.length) return null;
  const sys =
    `Ты отбираешь каналы-соседи по нише. Тебе дают НИШУ канала и ПОСТЫ другого канала.\n` +
    `Ответь ровно одним словом: ДА или НЕТ.\n` +
    `ДА — только если другой канал пишет ПРО ТО ЖЕ САМОЕ для тех же людей.\n` +
    `НЕТ — если тема другая, даже если аудитория частично пересекается.`;
  const user =
    `НИША МОЕГО КАНАЛА: ${brief.niche}. Для кого: ${brief.audience || "—"}.\n\n` +
    `ПОСТЫ ДРУГОГО КАНАЛА «${title || "без названия"}»:\n` +
    posts.slice(0, 4).map((t, i) => `${i + 1}. ${String(t).replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
  const a = await askAI(sys, user, 20, null);
  if (!a) return null;
  return /^\s*да/i.test(a.trim());
}

/**
 * ВТОРОЙ СУДЬЯ — для автодобавления. Спрашивает НЕ то же самое другими словами, а другое:
 * не «та же ли тема», а «пошёл бы за этим мой читатель».
 *
 * Зачем второй вопрос, а не второй прогон первого: всё суждение о нише стоит на четырёх
 * постах по 160 знаков — это ~640 символов. Прогнать тот же промпт дважды бессмысленно,
 * ошибки будут сцепленные: одна и та же модель на том же вопросе ошибётся одинаково.
 * Разные вопросы промахиваются в разных местах, поэтому «оба сказали ДА» — это уже
 * не мнение, а совпадение двух независимых взглядов.
 *
 * Применяем ТОЛЬКО к автодобавлению. Для показа человеку хватает первого судьи: там цена
 * ошибки — лишняя карточка в списке находок, а не молча испорченная медиана.
 */
async function wouldReaderFollow(brief, title, posts) {
  if (!brief?.niche || !posts.length) return null;
  const sys =
    `Ты решаешь, интересен ли один канал читателям другого.\n` +
    `Ответь ровно одним словом: ДА или НЕТ.\n` +
    `ДА — если человек, который читает первый канал, подписался бы и на второй, потому что тот полезен ему ровно тем же.\n` +
    `НЕТ — если это просто соседняя область: интересно вообще, но не за тем, зачем он читает первый.`;
  const user =
    `ЧЕЛОВЕК ЧИТАЕТ КАНАЛ ПРО: ${brief.niche}. Он: ${brief.audience || "—"}.\n\n` +
    `ПОСТЫ ДРУГОГО КАНАЛА «${title || "без названия"}»:\n` +
    posts.slice(0, 4).map((t, i) => `${i + 1}. ${String(t).replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
  const a = await askAI(sys, user, 20, null);
  if (!a) return null;
  return /^\s*да/i.test(a.trim());
}

/**
 * Общий справочник платформы: всё, что мы уже знаем о живых публичных каналах — те, кого
 * добавили другие люди, плюс общие источники «Насмотренности». Своих не возвращаем.
 * Это ответ на холодный старт: у первого пользователя ниши справочник пуст, у сотого —
 * богат. Каналы тут публичные, ничего личного мы не раскрываем.
 */
async function directoryPool(userId, channelId) {
  const r = await pool.query(
    `select distinct lower(handle) as h from (
        select handle from competitors where network = 'tg' and channel_id <> $2 and handle is not null
        union all
        select handle from trend_sources where enabled = true
     ) x
      where lower(x.handle) not in (
        select lower(handle) from channels where user_id = $1 and handle is not null
      )`,
    [userId, channelId],
  );
  return r.rows.map((x) => x.h).filter(Boolean);
}

/** Все @упоминания других каналов со страницы. Это и есть рёбра графа ниши. */
function mentionsOnPage(html, self) {
  const out = new Set();
  for (const m of html.matchAll(/t\.me\/([a-zA-Z][a-zA-Z0-9_]{3,31})/g)) {
    const h = m[1].toLowerCase();
    if (MENTION_STOP.has(h)) continue;
    if (h === String(self).toLowerCase()) continue;
    if (/bot$/i.test(h)) continue; // боты — не каналы
    out.add(h);
  }
  return out;
}

/**
 * Проход по нише ОДНОГО КАНАЛА. Возвращает число новых находок.
 * Сидим на самом канале и его конкурентах: без единого семени графа нет — так и скажем в UI.
 *
 * Канал здесь обязателен. Раньше сиды брались по всему аккаунту, а «своя ниша?» решалась по
 * одному брифу на человека — то есть у кого два канала, тому соседи канала про банкротство
 * оценивались брифом канала про ИИ в праве. Ниша — свойство канала, а не аккаунта.
 */
async function discoverForChannel(userId, channelId) {
  const seeds = (
    await pool.query(
      `select handle from competitors where channel_id = $1 and network = 'tg' and handle is not null
        union
       select handle from channels where id = $1 and network = 'tg' and handle is not null`,
      [channelId],
    )
  ).rows
    .map((r) => r.handle)
    .filter(Boolean);
  if (!seeds.length) return 0;

  // handle → множество семян, которые его упомянули
  const graph = new Map();

  for (const h of seeds) {
    try {
      const r = await fetch(`https://t.me/s/${String(h).replace(/^@/, "")}`, {
        headers: { "user-agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) continue;
      const html = await r.text();
      for (const m of mentionsOnPage(html, h)) {
        if (!graph.has(m)) graph.set(m, new Set());
        graph.get(m).add(String(h).toLowerCase());
      }
    } catch {
      /* один недоступный сид не должен ронять весь обход */
    }
    await sleep(250);
  }

  // Уже добавленных и себя не предлагаем.
  const known = new Set(seeds.map((s) => String(s).toLowerCase()));
  const dismissed = new Set(
    (
      await pool.query(
        `select handle from competitor_suggestions where channel_id = $1 and status <> 'new'`,
        [channelId],
      )
    ).rows.map((r) => r.handle),
  );

  // Число упоминаний РАНЖИРУЕТ, а не отсекает. Требование «минимум два независимых» звучало
  // разумно, но убивало всё: в реальном графе ниши каждый канал упомянут ровно одним соседом
  // (8 сидов → 16 упоминаний → 0 кандидатов с двумя). Настоящий фильтр — проверка живьём
  // ниже: существует, публичный, пишет, не гигант. Силу сигнала показываем человеку бейджем.
  const fromGraph = [...graph.entries()]
    .filter(([h]) => !known.has(h) && !dismissed.has(h))
    .map(([handle, by]) => ({ handle, by: [...by], fromPool: false }))
    .sort((a, b) => b.by.length - a.by.length);

  // ИСТОЧНИК 2 — общий справочник платформы. Нужен из-за холодного старта: граф упоминаний
  // свежего канала часто пуст. Проверено на живых бизнес-каналах: @bizlike упоминает 0,
  // @sberbusiness и @forbesrussia — только собственные каналы. Справочник у первого
  // пользователя ниши пуст (и это честно), у сотого — богат.
  const seen = new Set(fromGraph.map((c) => c.handle));
  const fromPool = (await directoryPool(userId, channelId))
    .filter((h) => !known.has(h) && !dismissed.has(h) && !seen.has(h))
    .map((handle) => ({ handle, by: [], fromPool: true }));

  // Граф идёт первым: «на него ссылается твой сосед» — сигнал сильнее, чем «его знает
  // платформа». Общий предел держим: каждая проверка — это запрос к t.me плюс вызов ИИ.
  const candidates = [...fromGraph, ...fromPool].slice(0, DISCOVER_CHECK_LIMIT);

  // Бриф — единственный источник правды о том, ЧТО за канал. Без него судить не по чему:
  // раньше я подбирал «популярные юридические», то есть по своему представлению о нише,
  // и приносил PR-агентство и софтверный блог только потому, что на них кто-то сослался.
  const brief = (
    await pool.query(`select * from content_brief where user_id = $1 and channel_id = $2`, [
      userId,
      channelId,
    ])
  ).rows[0];

  // АВТОДОБАВЛЕНИЕ — только на холодном старте. Новый канал = пустой экран трендов, и это
  // единственная боль, которую стоит лечить молча. Как только у канала есть хоть один
  // конкурент, лента живая, и доливать туда самовольно — значит лезть в чужую кухню.
  const haveCompetitors = (
    await pool.query(`select count(*)::int as n from competitors where channel_id = $1`, [channelId])
  ).rows[0].n;
  let autoLeft = haveCompetitors === 0 ? AUTO_ADD_MAX : 0;
  const autoAdded = [];

  let added = 0;
  for (const c of candidates) {
    try {
      // Проверяем живьём: существует, публичный, пишет. Непроверенных не показываем.
      const page = await fetchCompetitorPage(c.handle);
      if (!page.ok || page.posts.length < 5) continue;
      if (page.subscribers != null && page.subscribers > DISCOVER_MAX_SUBS) continue;

      const texts = page.posts.map((p) => p.text).filter(Boolean);
      const onTopic = await sameNiche(brief, page.title, texts);

      const r = await pool.query(
        `insert into competitor_suggestions (user_id, channel_id, handle, title, subscribers, posts, mentioned_by, sources, on_topic)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (channel_id, handle) do update set
           title = coalesce($4, competitor_suggestions.title),
           subscribers = coalesce($5, competitor_suggestions.subscribers),
           posts = $6,
           mentioned_by = greatest(competitor_suggestions.mentioned_by, $7),
           sources = $8,
           on_topic = $9
         where competitor_suggestions.status = 'new'
         returning (xmax = 0) as inserted`,
        // mentioned_by = 0 у находок из справочника: на них никто из твоих не ссылался, их
        // просто знает платформа. UI по этому нулю и отличает одно от другого.
        [userId, channelId, c.handle, page.title, page.subscribers, page.posts.length, c.by.length, c.by, onTopic],
      );
      if (r.rows[0]?.inserted && onTopic !== false) added++;
      console.log(
        `[поиск]   @${c.handle}: ${onTopic === true ? "своя ниша ✅" : onTopic === false ? "мимо ❌" : "судить нечем (нет ИИ)"}`,
      );

      // Второго судью зовём ТОЛЬКО когда первый сказал ДА и место ещё есть: на остальных
      // это был бы вызов ИИ впустую.
      //
      // Условие строго `=== true`, а не «не false»: sameNiche возвращает null, когда движок
      // молчит (нет ключа, Ollama лежит, таймаут). Показывать непроверенных человеку можно —
      // он посмотрит сам; молча добавлять их нельзя. Иначе в первый же день без ИИ платформа
      // набьёт канал кем попало.
      if (autoLeft > 0 && onTopic === true) {
        const follows = await wouldReaderFollow(brief, page.title, texts);
        if (follows === true) {
          const ins = await pool.query(
            `insert into competitors (user_id, channel_id, network, handle, title, subscribers, status, auto_added)
             values ($1, $2, 'tg', $3, $4, $5, 'pending', true)
             on conflict (channel_id, network, handle) do nothing
             returning id`,
            [userId, channelId, c.handle, page.title, page.subscribers],
          );
          if (ins.rowCount) {
            // Находку помечаем принятой: иначе она осталась бы висеть в списке «подтверди»
            // рядом с уже добавленным каналом.
            await pool.query(
              `update competitor_suggestions set status = 'added'
                where channel_id = $1 and handle = $2`,
              [channelId, c.handle],
            );
            autoLeft--;
            autoAdded.push(c.handle);
            console.log(`[поиск]   @${c.handle}: оба судьи ЗА → добавлен автоматически 🤝`);
          }
        } else {
          console.log(
            `[поиск]   @${c.handle}: второй судья ${follows === false ? "против" : "молчит"} → только в находки`,
          );
        }
      }
    } catch (err) {
      console.error(`[поиск] @${c.handle}:`, err?.message);
    }
    await sleep(250);
  }

  console.log(
    `[поиск] user ${userId}/канал ${channelId}: сидов ${seeds.length}, кандидатов ${candidates.length}, новых ${added}`,
  );
  return added;
}

/** Разведка по всем каналам аккаунта: у каждого своя ниша — значит, свой проход. */
async function discoverForUser(userId) {
  const chans = (
    await pool.query(
      `select id from channels where user_id = $1 and network = 'tg' and is_active = true order by id`,
      [userId],
    )
  ).rows;
  let total = 0;
  for (const ch of chans) total += await discoverForChannel(userId, ch.id);
  return total;
}

// ============================================================================
// Д.7 — детектор залётов + генератор идей «Сними это». Детекция — чистая
// математика. Тема/хук/сценарий/«почему» пишет ИИ (Hermes); если движок
// недоступен — идея сохраняется без текста (ai_status='pending'), честно.
// ============================================================================

// Порог залёта считаем ОТ САМОГО КАНАЛА, а не фиксированным числом.
// Раньше было «медиана × 5» — и это не срабатывало вообще ни у кого: на живых данных
// даже официальный @telegram с 10 млн подписчиков даёт максимум ×2,2 к своей медиане.
// Залёт = пост в верхних 10% СВОЕГО канала И минимум ×1,5 к медиане. Второе условие
// обязательно: без него «верхние 10%» на ровной выборке объявят залётом обычный пост.
const HIT_MIN_RATIO = Number(process.env.HIT_MIN_RATIO || 1.5);
const HIT_PERCENTILE = 0.9;

// Ниже этого статистика — шум, а не сигнал. У канала с медианой 5 просмотров один
// случайный зритель даёт «×1,4 к норме»: строить на этом контент-план нельзя.
const MIN_POSTS_FOR_STATS = 8;
const MIN_MEDIAN_VIEWS = 20;

function median(nums) {
  const a = nums.filter((x) => x != null).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

/** Перцентиль с линейной интерполяцией (p — доля, 0.9 = верхние 10%). */
function percentile(nums, p) {
  const a = nums.filter((x) => x != null).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

/** Данных мало: цифры покажем с плашкой, но в контент-план такое не отдаём. */
function thinData(views) {
  return views.length < MIN_POSTS_FOR_STATS || median(views) < MIN_MEDIAN_VIEWS;
}

// Генерация идей/планов в воркере без стрима. Выбирает движок (облако/локально) сам.
// null, если движок недоступен — тогда идея/план сохраняются без ИИ-текста (честно).
async function askAI(system, user, numPredict = 500, mood = null, tempOverride = null) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  // Точным задачам (JSON-извлечение профиля) настроение мешает — перекрываем температуру.
  const temp = tempOverride ?? moodTempW(mood);
  try {
    if (CLOUD_KEY) {
      const r = await fetch(`${CLOUD_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${CLOUD_KEY}` },
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({ model: CLOUD_MODEL, temperature: temp, messages }),
      });
      if (!r.ok) return null;
      const d = await r.json();
      return d?.choices?.[0]?.message?.content?.trim() || null;
    }
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model: AI_MODEL,
        stream: false,
        options: { temperature: temp, num_predict: numPredict },
        messages,
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

const IDEA_SYSTEM = `Ты — контент-стратег. По залетевшему посту конкурента предложи автору СВОЙ пост на ту же тему — не копию, свой угол. Пиши грамотным живым русским, обращайся к автору на «ты». Ответь СТРОГО в таком формате, без лишнего:
ТЕМА: <одна короткая строка>
ХУК: <первая цепляющая фраза>
СЦЕНАРИЙ: <2-4 коротких шага>
ПОЧЕМУ: <почему этот формат зашёл, 1-2 предложения>`;

async function generateIdea(post, comp) {
  const snippet = (post.text || "").replace(/\s+/g, " ").slice(0, 400) || "(пост без текста, только медиа)";
  const ratio = post.hit_ratio != null ? Number(post.hit_ratio).toFixed(1) : "5+";
  const prompt = `Конкурент «${comp.title || comp.handle}». У него залетел пост — в ${ratio} раза выше его нормы:\n"""${snippet}"""\nПредложи мне свой пост на эту тему.`;
  const mood = await userMood(comp.user_id); // настроение агента влияет и на идеи
  const text = await askAI(IDEA_SYSTEM + "\n" + moodPromptW(mood), prompt, 500, mood);
  if (!text) return null;
  const grab = (label) => {
    const m = text.match(
      new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n(?:ТЕМА|ХУК|СЦЕНАРИЙ|ПОЧЕМУ):|$)`, "i"),
    );
    return m ? m[1].trim() : null;
  };
  return { topic: grab("ТЕМА"), hook: grab("ХУК"), structure: grab("СЦЕНАРИЙ"), why: grab("ПОЧЕМУ") };
}

async function detectHits(comp) {
  const posts = (
    await pool.query(
      `select id, tg_msg_id, text, views, hit_ratio from competitor_posts
        where competitor_id = $1 and views is not null`,
      [comp.id],
    )
  ).rows;
  if (posts.length < 5) return; // мало данных для честной медианы
  const views = posts.map((p) => p.views);
  const med = median(views);
  if (med <= 0) return;
  const top10 = percentile(views, HIT_PERCENTILE);

  for (const p of posts) {
    const ratio = Math.round((p.views / med) * 10) / 10;
    const isHit = p.views >= top10 && ratio >= HIT_MIN_RATIO;
    // Залёт «липкий»: once a hit — always a hit. Медиана со временем растёт, но исторический
    // всплеск не отменяем — иначе пограничный залёт потерялся бы (ревью Д.7).
    await pool.query(
      `update competitor_posts set is_hit = (is_hit or $2), hit_ratio = $3 where id = $1`,
      [p.id, isHit, ratio],
    );
  }

  // Канал слишком мелкий/молодой: «залёт» на такой выборке — статистический шум.
  // В Трендах покажем (с честной плашкой), но идеи для контент-плана на этом не строим.
  if (thinData(views)) {
    console.log(
      `[hits] @${comp.handle}: данных мало (${posts.length} постов, медиана ${med}) — идеи не генерирую`,
    );
    return;
  }

  // Залёты без ГОТОВОЙ идеи → генерируем. Берём и новые, и те, где ИИ был недоступен раньше
  // (ai_status='pending'), чтобы идея не потерялась навсегда (ревью Д.7).
  const fresh = (
    await pool.query(
      `select cp.id, cp.tg_msg_id, cp.text, cp.hit_ratio from competitor_posts cp
        where cp.competitor_id = $1 and cp.is_hit = true
          and not exists (
            select 1 from content_ideas ci
             where ci.source_post_id = cp.id and ci.user_id = $2 and ci.ai_status = 'ready')
        order by cp.hit_ratio desc limit 3`,
      [comp.id, comp.user_id],
    )
  ).rows;

  for (const p of fresh) {
    // Атомарно «заявляем» залёт строкой-заглушкой. Уведомляем ТОЛЬКО если вставили её МЫ —
    // так при гонке (ручной сбор + интервал) уведомление уходит один раз (ревью Д.7).
    const claimed = await pool.query(
      `insert into content_ideas (user_id, competitor_id, source_post_id, format, hit_ratio, ai_status)
       values ($1, $2, $3, 'post', $4, 'pending')
       on conflict (user_id, source_post_id) do nothing returning id`,
      [comp.user_id, comp.id, p.id, p.hit_ratio],
    );
    const isNew = claimed.rowCount > 0;

    const idea = await generateIdea(p, comp);
    if (idea) {
      await pool.query(
        `update content_ideas set topic = $4, hook = $5, structure = $6, why_it_worked = $7,
                hit_ratio = $8, ai_status = 'ready'
          where user_id = $1 and competitor_id = $2 and source_post_id = $3 and ai_status <> 'ready'`,
        [comp.user_id, comp.id, p.id, idea.topic, idea.hook, idea.structure, idea.why, p.hit_ratio],
      );
    }
    // ИИ недоступен → строка остаётся ai_status='pending', следующий проход дозаполнит. Честно.

    if (isNew) {
      const ratio = p.hit_ratio != null ? Number(p.hit_ratio).toFixed(1) : "5+";
      const link = `https://t.me/${comp.handle}/${p.tg_msg_id}`;
      const hitText =
        `🔥 У «${comp.title || comp.handle}» залетело — ×${ratio} к норме.\n` +
        (idea?.topic ? `Тема: ${idea.topic}\n` : "") +
        link;
      // Тот самый вау-момент из ТЗ: залёт → кнопка → готовый черновик. Теперь без ноутбука.
      const hitBtns = [[{ text: "Сними это", data: `idea:${p.id}` }, { text: "Оригинал", url: link }]];
      // Нет привязанного чата — выбор пользователя, владельцу чужой залёт не шлём (была утечка).
      await notifyUser(comp.user_id, hitText, hitBtns);
      console.log(`[hits] @${comp.handle}: залёт ×${ratio}${idea ? " + идея" : " (идея позже)"}`);
    }
  }
}

// Обойти конкурентов, которым пора обновиться: новые (pending) сразу, остальные — раз в ~2 часа
// (свежие посты). Полный проход и так идёт каждые 2 часа по таймеру ниже.
async function collectCompetitors() {
  const rows = (
    await pool.query(
      `select id, user_id, handle, title from competitors
        where network = 'tg'
          and (status = 'pending' or collected_at is null or collected_at < now() - interval '2 hours')`,
    )
  ).rows;
  await mapConcurrent(rows, RECON_CONCURRENCY, async (c) => {
    try {
      await collectCompetitor(c);
    } catch (err) {
      console.error(`[recon] @${c.handle} сбор упал:`, err?.message);
      await pool
        .query(`update competitors set status = 'error', last_error = $2 where id = $1`, [
          c.id,
          String(err?.message || err).slice(0, 300),
        ])
        .catch(() => {});
    }
  });
  if (rows.length) console.log(`[recon] цикл: обработано ${rows.length}`);
}

/**
 * Поиск соседей по нише для всех, у кого есть от чего плясать. Раз в сутки, а не каждые 2 часа:
 * граф ниши меняется медленно, а каждый проход — это десятки запросов к t.me. Долбить их
 * чаще — верный способ получить 429 и потерять всю разведку разом.
 */
async function discoverAll() {
  const users = (
    await pool.query(
      `select distinct u.id from users u
        where exists (select 1 from channels c where c.user_id = u.id and c.network = 'tg' and c.handle is not null)
           or exists (select 1 from competitors k where k.user_id = u.id and k.network = 'tg')`,
    )
  ).rows;
  await mapConcurrent(users, RECON_CONCURRENCY, async (u) => {
    try {
      await discoverForUser(u.id);
    } catch (err) {
      console.error(`[поиск] user ${u.id} упал:`, err?.message);
    }
  });
}

// ============================================================================
// Д.7+ — «Насмотренность»: общие источники ниши. Тот же парсер t.me/s/, что и в разведке,
// но список ОДИН на всю платформу: 12 запросов в цикл на всех, а не 20 на каждого юзера.
// Идеи по ним НЕ генерируем и в бот не уведомляем — это витрина, а не разведка.
// ============================================================================

async function collectTrendSource(src) {
  const page = await fetchCompetitorPage(src.handle);

  if (!page.ok || (page.posts.length === 0 && page.title == null)) {
    await pool.query(
      `update trend_sources set status = 'error', last_error = $2, collected_at = now() where id = $1`,
      [src.id, "Канал не открылся — публичной страницы нет"],
    );
    console.log(`[насмотренность] @${src.handle}: не открылся`);
    return;
  }

  for (const p of page.posts) {
    await pool.query(
      `insert into trend_posts (source_id, tg_msg_id, text, views, reactions, media, photo_url, posted_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (source_id, tg_msg_id) do update set
         text = $3, views = $4, reactions = $5, media = $6,
         photo_url = coalesce($7, trend_posts.photo_url),
         posted_at = coalesce(trend_posts.posted_at, $8), collected_at = now()`,
      [src.id, p.msgId, p.text, p.views, p.reactions, p.media, p.photoUrl, p.postedAt],
    );
  }

  await pool.query(
    `update trend_sources set title = coalesce($2, title), subscribers = coalesce($3, subscribers),
            status = 'ready', last_error = null, collected_at = now() where id = $1`,
    [src.id, page.title, page.subscribers],
  );
  const photos = page.posts.filter((p) => p.photoUrl).length;
  console.log(`[насмотренность] @${src.handle}: ${page.posts.length} постов, ${photos} с фото`);
}

// Обходим источники, которым пора обновиться. Быстрые каналы (Право.ru — 7 постов в сутки)
// на одной странице дают меньше 48ч истории, поэтому норму по ним не посчитать сразу —
// но каждый заход дописывает свежее, и за несколько дней история накапливается сама.
async function collectTrendSources() {
  const rows = (
    await pool.query(
      `select id, handle, title from trend_sources
        where enabled = true
          and (collected_at is null or collected_at < now() - interval '2 hours')`,
    )
  ).rows;
  await mapConcurrent(rows, RECON_CONCURRENCY, async (s) => {
    try {
      await collectTrendSource(s);
    } catch (err) {
      console.error(`[насмотренность] @${s.handle} упал:`, err?.message);
      await pool
        .query(`update trend_sources set status = 'error', last_error = $2 where id = $1`, [
          s.id,
          String(err?.message || err).slice(0, 300),
        ])
        .catch(() => {});
    }
  });
  if (rows.length) console.log(`[насмотренность] цикл: обработано ${rows.length}`);
}

// ============================================================================
// Д.9 — автопилот. Дирижёр: ИИ собирает план недели с опорой на аналитику (Д.5) и
// залёты (Д.7), в стиле пользователя. Пользователь одобряет → посты в очередь (Д.3).
// ============================================================================

// Бриф контента (Д.9). Сам контракт качества общий с Next.js — post-quality.mjs чистый,
// поэтому промпт и программный шлагбаум не могут разъехаться между приложением и worker.
const RUBRICS_W = [
  "Полезный совет",
  "Личная история",
  "Разбор ошибки",
  "Ответ на вопрос",
  "Инструкция по шагам",
  "Разбор кейса",
  "Итоги и подборки",
  "Мифы и правда",
  "За кулисами",
];

/** Готовый бриф КАНАЛА или null. null = автопилот запускать нельзя. */
async function loadBriefW(userId, channelId) {
  const b = (
    await pool.query(
      `select niche, audience, rubrics, goal, cta, taboo, quality, ready
         from content_brief where user_id = $1 and channel_id = $2`,
      [userId, channelId],
    )
  ).rows[0];
  if (!b || !b.ready) return null;
  const niche = String(b.niche || "").trim();
  const audience = String(b.audience || "").trim();
  if (niche.length < 3 || audience.length < 3) return null;
  return {
    ...b,
    niche,
    audience,
    rubrics: b.rubrics || [],
    quality: normalizePostQuality(b.quality),
  };
}

function briefContextW(b) {
  const lines = ["О канале, для которого пишешь:", `— тема: ${b.niche}`];
  if (b.audience) lines.push(`— читатель: ${b.audience}`);
  if (b.goal) lines.push(`— зачем автор ведёт канал: ${b.goal}`);
  if (b.cta) lines.push(`— куда ведём читателя: ${b.cta}`);
  if (b.rubrics.length) lines.push(`— рубрики канала: ${b.rubrics.join(", ")}`);
  if (b.taboo) lines.push("", `Категорически не пиши про: ${b.taboo}`);
  lines.push(
    "",
    "Пиши предметно и по этой теме. Никаких общих слов про «твою тему» — только конкретика ниши.",
  );
  return lines.join("\n");
}

// Единые требования к структуре поста. Одинаковы в промпте (ИИ старается) и в
// форматтере-гаранте (дожимаем программно). Цель — пост не «простыня», а воздух:
// короткие абзацы, пустые строки между блоками, списки столбиком.
const FORMAT_RULES_W = [
  "ФОРМАТ ПОСТА (обязательно):",
  "— первая строка — короткий хук (до 60 символов), сразу цепляет;",
  "— абзацы по 1–3 предложения, между абзацами — ПУСТАЯ строка;",
  "— никаких «простыней»: сплошной текст длиннее 3 строк без переноса запрещён;",
  "— перечисления — столбиком, каждый пункт с новой строки через «—» или «•»;",
  "— ключевую мысль выдели **жирным** (одну, максимум две);",
  "— финальный абзац — вывод или вопрос читателю, отдельным блоком;",
  "— никаких мета-меток: не пиши «Хук:», «Абзац:», «CTA:» — только сам текст.",
].join("\n");

function postSystem(samples, brief, support = [], quality, postIndex = 0) {
  let s =
    "Ты — строгий выпускающий редактор Telegram-канала. Выдай ТОЛЬКО готовый текст поста, без пояснений, приветствий и подписи.\n\n" +
    FORMAT_RULES_W +
    "\n\n" +
    buildQualityPrompt(quality, { postIndex });
  if (brief) s += "\n\n" + briefContextW(brief);

  // Факты из базы знаний канала. Замерено на hermes3: без фактов модель заполняет пустоту
  // выдумкой (в канал ушло «решение суда от 10 июля 2026 года», которого не существует).
  // С фактами — держится за них и не сочиняет. То есть враньё было не распущенностью
  // модели, а пустым контекстом: ей нечего было сказать, и она придумывала.
  //
  // Ссылки [1]/[2] — не украшение, а ПРОВЕРЯЕМЫЙ след: утверждение без ссылки видно сразу,
  // и такой пост можно не выпускать. На замере вариант со ссылками дал самый чистый текст
  // и 3 ссылки; вариант с одним лишь запретом — 0 ссылок и искажение факта.
  if (support.length) {
    s +=
      "\n\nФАКТЫ (только из них можно брать сведения):\n" +
      support.map((c, i) => `[${i + 1}] ${c.text}`).join("\n") +
      "\n\nПиши ТОЛЬКО по этим фактам. После каждого утверждения ставь его номер: [1], [2]." +
      "\nЗапрещено добавлять номера дел, даты, суммы, сроки, названия судов и любые сведения," +
      " которых нет в фактах. Не выдумывай примеры и истории.";
  }

  const ss = (samples || []).filter(Boolean).slice(0, 8);
  if (ss.length)
    s +=
      "\n\nПримеры постов автора — держись его стиля" +
      (support.length ? " (но факты бери ТОЛЬКО из списка выше)" : "") +
      ":\n" +
      ss.map((x) => "---\n" + x).join("\n");
  return s;
}

/**
 * Конкретные темы недели. Раньше здесь были заглушки вида «Полезный совет по твоей
 * теме» — их и уносило в ИИ как тему, поэтому посты выходили ни о чём. Теперь темы
 * придумывает ИИ ПОД НИШУ из брифа; залёты конкурентов (Д.7) идут первыми.
 * Возвращает [{ topic, rubric }]. Пусто = движок молчит, врать не будем.
 */
async function planTopics(brief, need, hitTopics, mood, channelId = null) {
  const out = hitTopics.slice(0, need).map((t) => ({ topic: t, rubric: null }));
  if (out.length >= need) return out;

  // ТЕМЫ ИЗ БАЗЫ ЗНАНИЙ. Здесь был корень вранья, и он не в посте, а в теме: ниже стоит
  // задание «придумай конкретную предметную тему» без единого факта — ИИ и придумывал.
  // Так в план попали «Юрист, предприниматель и крестовский остров — что же это было?» и
  // «Человек с кредитной историей -3, но купил квартиру через МФО». Выдуманная тема дальше
  // ЗАСТАВЛЯЕТ выдумать текст под себя: пост обязан рассказать то, чего не было.
  // Поэтому тему теперь даёт факт из базы, а не фантазия.
  if (out.length < need && channelId) {
    const seeds = (
      await pool.query(
        `select id, text from knowledge_chunks
          where channel_id = $1 and kind in ('fact', 'law', 'case', 'qa', 'service')
            and (valid_until is null or valid_until >= current_date)
          order by used_count asc, id
          limit $2`,
        [channelId, need - out.length],
      )
    ).rows;
    const titleSystem = [
      "Ты — редактор Telegram-канала. Из факта делаешь заголовок будущего поста.",
      "Заголовок 3–9 слов, без кавычек и точки в конце.",
      "Брать можно ТОЛЬКО то, что есть в факте: не добавляй цифр, дат и случаев.",
      "Выдай ровно один заголовок и больше ничего.",
    ].join("\n");
    for (const seed of seeds) {
      if (out.length >= need) break;
      const safe = fallbackTopicFromSeed(seed.text);
      let topic = safe;
      // Для знакомых конструкций детерминированный заголовок точнее и быстрее слабой
      // локальной модели. На неизвестной нише даём модели шанс, но принимаем ответ только
      // после отдельной проверки темы; иначе остаётся нейтральный безопасный fallback.
      if (safe.startsWith("Практический разбор:")) {
        const raw = await askAI(titleSystem, `Факт: ${seed.text}`, 60, mood, 0.25);
        const candidate = String(raw || "")
          .split("\n")[0]
          .replace(/^\s*[-–—•*\d.)\s]+/, "")
          .replace(/^["«]+|["».]+$/g, "")
          .trim();
        if (validateTopicQuality(candidate, seed.text).passed) topic = candidate;
      }
      const checked = validateTopicQuality(topic, seed.text);
      if (checked.passed) out.push({ topic: checked.value, rubric: null, seed: seed.id });
    }
    if (out.length >= need) return out;
  }

  const want = need - out.length;
  const list = brief.rubrics.length ? brief.rubrics : RUBRICS_W;
  const system = [
    "Ты — редактор Telegram-канала. Придумываешь конкретные темы будущих постов.",
    "",
    briefContextW(brief),
    "",
    "Правила:",
    "— тема конкретная и предметная, по нише канала;",
    "— из заголовка сразу понятно, о чём пост: не «полезный совет», а какой именно;",
    "— 3–9 слов, без нумерации, без кавычек, без точки в конце;",
    "— темы не повторяют друг друга;",
    // Прямое лекарство от «крестовского острова» и «кредитной истории -3». Под выдуманную
    // тему проверенных материалов нет по определению — значит пост придётся сочинить.
    "— НЕ выдумывай случаи, дела, проекты, названия и цифры: тема должна быть о том, что",
    "  верно и без ссылки на источник, а не о придуманной истории;",
    "— никаких номеров дел, статей, дат и сумм в теме.",
    "",
    `Формат каждой строки строго такой: Рубрика :: Тема`,
    `Рубрику бери только из списка: ${list.join(", ")}.`,
    "",
    `Выдай ровно ${want} ${plural(want, "строку", "строки", "строк")}. Больше ничего не пиши.`,
  ].join("\n");

  const avoid = out.length ? ` Не повторяй уже взятые темы: ${out.map((o) => o.topic).join("; ")}.` : "";
  const raw = await askAI(system, `Придумай темы на неделю.${avoid}`, 400, mood);

  for (const line of String(raw || "").split("\n")) {
    const s = line.replace(/^\s*[-–—•*\d.)\s]+/, "").trim();
    if (!s) continue;
    let rubric = null;
    let topic = s;
    const parts = s.split("::");
    if (parts.length >= 2) {
      rubric = parts[0].trim();
      topic = parts.slice(1).join("::").trim();
    }
    topic = topic.replace(/^["«]+|["»]+$/g, "").trim();
    if (rubric && !list.includes(rubric)) rubric = null;
    if (topic.length >= 8 && topic.length <= 120) out.push({ topic, rubric });
    if (out.length >= need) break;
  }
  return out;
}

// Потолок постов в неделю. Это НЕ вкус и не «так решили»: план собирается ИИ последовательно,
// один пост за вызов, и каждый вызов может тянуться до 90 секунд. 30 постов — это уже до
// получаса генерации на одного человека. Ставить сюда «бесконечность» — значит подвесить
// воркер на часы и лишить остальных публикации. Хочешь больше — надо распараллелить askAI,
// это отдельная работа.
const MAX_WEEKLY_POSTS = 30;

// План собирается ДЛЯ КАНАЛА. Раньше здесь стоял `limit 1` без order by: у кого два канала,
// тот получал посты по брифу одного канала в (случайно выбранный) другой, а второй канал молчал.
async function buildAutopilotPlan(userId, channelId, expectedPlanId = null) {
  // A manual build is tied to the placeholder created by the API. Old duplicate jobs used
  // to rebuild the same channel one after another and could overwrite a newer retry. A job
  // whose placeholder is gone or no longer `building` is obsolete and must do no work.
  if (expectedPlanId != null) {
    const expected = await pool.query(
      `select 1 from autopilot_plan
        where id = $1 and user_id = $2 and channel_id = $3 and status = 'building'`,
      [expectedPlanId, userId, channelId],
    );
    if (!expected.rowCount) {
      console.log(`[auto] plan ${expectedPlanId}: задача устарела — пропускаю`);
      return { superseded: true };
    }
  }

  const ch = (
    await pool.query(
      `select id, title from channels
        where id = $1 and user_id = $2 and network = 'tg' and is_active = true`,
      [channelId, userId],
    )
  ).rows[0];
  if (!ch) {
    console.log(`[auto] user ${userId}: канал ${channelId} недоступен — план не собрать`);
    return { error: "no_channel" };
  }

  // Без брифа ИИ не знает, о чём канал, и напишет наугад. Лучше честно не собрать план,
  // чем выдать пять постов ни о чём (ТЗ Д.9).
  const brief = await loadBriefW(userId, channelId);
  if (!brief) {
    console.log(`[auto] user ${userId}/${channelId}: нет брифа — план не собрать`);
    return { error: "no_brief" };
  }

  const st = (
    await pool.query(
      `select post_frequency, mode, approvals_streak from autopilot_settings
        where user_id = $1 and channel_id = $2`,
      [userId, channelId],
    )
  ).rows[0];
  const N = Math.max(1, Math.min(MAX_WEEKLY_POSTS, st?.post_frequency || 5));

  // Лучшее время из аналитики Д.5: час МСК с наибольшим средним просмотром.
  const published = (
    await pool.query(
      `select p.published_at,
              (select views from post_stats where post_id = p.id order by snapshot_date desc limit 1) as views
         from posts p
        where p.user_id = $1 and p.channel_id = $2
          and p.status = 'published' and p.published_at is not null`,
      [userId, channelId],
    )
  ).rows;
  let bestHour = 19;
  let rule;
  const wv = published.filter((p) => p.views != null);
  if (wv.length >= 3) {
    const byHour = new Map();
    for (const p of wv) {
      const h = Number(
        new Date(p.published_at).toLocaleString("ru-RU", {
          timeZone: "Europe/Moscow",
          hour: "2-digit",
          hour12: false,
        }),
      );
      (byHour.get(h) ?? byHour.set(h, []).get(h)).push(p.views);
    }
    let bh = -1;
    let ba = -1;
    for (const [h, vs] of byHour) {
      const a = vs.reduce((s, v) => s + v, 0) / vs.length;
      if (a > ba) {
        ba = a;
        bh = h;
      }
    }
    if (bh >= 0) {
      bestHour = bh;
      rule = `Ставлю посты на ${String(bh).padStart(2, "0")}:00 МСК — по твоей аналитике в это время у тебя больше просмотров.`;
    }
  }
  if (!rule)
    rule = `Аналитики пока мало — поставил вечер (${String(bestHour).padStart(2, "0")}:00 МСК), обычно заходит лучше. Дальше подстроюсь под твои настоящие цифры.`;

  // Больше семи в неделю — значит несколько в день, и «ставлю на 19:00» перестаёт быть правдой.
  // Объясняем, что на самом деле произойдёт, а не оставляем прежний текст.
  if (N > 7) {
    const perDay = Math.ceil(N / 7);
    rule =
      `${N} ${plural(N, "пост", "поста", "постов")} в неделю — это ${perDay} в день. ` +
      `Развожу их по дню с 9:00 до 21:00 МСК, чтобы подписчик не получал пачку подряд.`;
  }

  const quality = brief.quality;

  // Залёт конкурента — только сигнал, а не редакционное задание. По умолчанию темы
  // конкурентов выключены: раньше нерелевантный хит молча уводил весь план в сторону.
  const ideaTopics = quality.competitorTopics
    ? (
        await pool.query(
          `select ci.topic from content_ideas ci
             join competitors c on c.id = ci.competitor_id
            where ci.user_id = $1 and c.channel_id = $2 and ci.status = 'new' and ci.topic is not null
            order by ci.hit_ratio desc nulls last limit $3`,
          [userId, channelId, N],
        )
      ).rows.map((r) => r.topic)
    : [];
  if (ideaTopics.length)
    rule += ` Взял ${ideaTopics.length} ${plural(ideaTopics.length, "тему", "темы", "тем")} из залётов конкурентов.`;

  // Стиль берём только из примеров, которые человек явно положил в настройку. История
  // published загрязнялась тестами и случайными постами, а worker затем тиражировал их голос.
  const samples = quality.styleExamples;

  // Пересборка не должна плодить дубли: снимаем ещё не вышедшие посты прошлого плана (ревью Д.9).
  await cancelPreviousPlan(userId, channelId);

  // Полный режим требует и mode='full', и заслуженный streak (защита в глубину, ревью).
  const full = (st?.mode || "confirm") === "full" && (st?.approvals_streak ?? 0) >= 2;
  const planMood = await userMood(userId); // настроение агента для постов плана
  // Время постов считаем ЗАРАНЕЕ на всю неделю: раскладка зависит от их числа, а не от порядка.
  const slots = weekSlots(N, bestHour);

  // Сначала конкретные темы под нишу, только потом тексты.
  const topics = await planTopics(brief, N, ideaTopics, planMood, channelId);
  if (!topics.length) {
    console.log(`[auto] user ${userId}: ИИ не дал тем — план не собрать`);
    return { error: "ai_unavailable" };
  }
  rule += ` Темы — под твою нишу: ${brief.niche}.`;

  const facts = (
    await pool.query(
      `select count(*)::int as n from knowledge_chunks where channel_id = $1 and kind <> 'voice'`,
      [channelId],
    )
  ).rows[0].n;
  rule += facts
    ? ` Факты — из твоей базы знаний (${facts} ${plural(facts, "кусок", "куска", "кусков")}).`
    : ` База знаний пуста, поэтому пишу без конкретики — ни дат, ни сумм, ни номеров дел выдумывать не стану. Добавь материалы, и посты станут предметными.`;
  rule += ` Каждый текст проходит редакционный порог ${quality.qualityThreshold}/100; нарушение жёстких правил блокирует выпуск.`;

  // Генерация постов — узкое место плана: каждый пост это findSupport + askAI (~90с) + возможный
  // ретрай. Последовательно 30 постов собирались до 45 минут и всё это время держали крон-очередь
  // (concurrency: 1), простаивая разведку и аналитику. Параллелим через mapConcurrent — порядок
  // элементов сохраняется по индексу, поэтому slots[i] и нумерация карточек не разъезжаются.
  const items = await mapConcurrent(topics, AUTOPILOT_CONCURRENCY, async (t, i) => {
    const { topic, rubric } = t;
    // Опора под КАЖДУЮ тему. В строгом профиле пустая опора — блокер, а не разрешение
    // модели заполнить пробел убедительно звучащей выдумкой.
    const support = await findSupport(channelId, topic);
    const system = postSystem(samples, brief, support, quality, i);
    const task = rubric
      ? `Напиши пост в рубрику «${rubric}» на тему: ${topic}.`
      : `Напиши пост на тему: ${topic}.`;
    const outputTokens = Math.min(900, Math.max(400, Math.ceil(quality.maxChars / 2)));
    let candidateRaw = await askAI(system, task, outputTokens, null, 0.45);
    let aiDraft = candidateRaw ? stripCites(candidateRaw) : null;
    let cited = support.length && candidateRaw ? citedShare(candidateRaw) : null;
    let invented = aiDraft ? findInvented(aiDraft, support) : [];
    let qualityResult = validatePostQuality(aiDraft || "", quality, {
      topic,
      postIndex: i,
      supportCount: support.length,
      citedShare: cited,
      invented,
    });

    // Модель получает замечания выпускающего редактора и переписывает весь текст. После
    // каждой попытки работает тот же программный валидатор. Retry не является обходом:
    // если правила так и не выполнены, карточка остаётся заблокированной.
    for (let attempt = 0; attempt < quality.retryLimit && !qualityResult.passed; attempt++) {
      if (qualityResult.violations.some((v) => v.code === "no_sources")) break;
      console.log(
        `[auto]   «${topic.slice(0, 40)}»: ${qualityResult.score}/100 — редактура ${attempt + 1}/${quality.retryLimit}`,
      );
      candidateRaw = await askAI(
        system,
        candidateRaw ? buildRewritePrompt(candidateRaw, qualityResult) : task,
        outputTokens,
        null,
        0.35,
      );
      aiDraft = candidateRaw ? stripCites(candidateRaw) : null;
      cited = support.length && candidateRaw ? citedShare(candidateRaw) : null;
      invented = aiDraft ? findInvented(aiDraft, support) : [];
      qualityResult = validatePostQuality(aiDraft || "", quality, {
        topic,
        postIndex: i,
        supportCount: support.length,
        citedShare: cited,
        invented,
      });
    }

    const draft = aiDraft || `Черновик на тему «${topic}» — ИИ допишет, когда движок будет доступен.`;
    let scheduledAt = slots[i];
    const item = {
      i,
      scheduledAt,
      topic,
      rubric,
      draft,
      status: "pending",
      aiReady: !!aiDraft,
      // Чем пост подкреплён — покажем человеку в карточке: это и есть доказательство,
      // что цифры не выдуманы, а взяты из его же материалов.
      sources: support.map((c) => ({ id: c.id, text: c.text.slice(0, 120) })),
      cited,
      // Непустое — в посте осталась непроверенная конкретика. Человек увидит предупреждение,
      // а автопубликация для такого поста закрыта.
      invented: invented.length ? invented : undefined,
      qualityBlocked: !aiDraft || !qualityResult.passed,
      quality: qualityResult,
      qualityOrigin: "automatic",
    };
    if (support.length) {
      await pool
        .query(`update knowledge_chunks set used_count = used_count + 1 where id = any($1)`, [
          support.map((c) => c.id),
        ])
        .catch(() => {});
    }
    // Полный режим публикует БЕЗ подтверждения — но ТОЛЬКО настоящий ИИ-текст. Заглушку
    // (ИИ недоступен) в живой канал автоматически не отправляем: оставляем на подтверждение (честность).
    //
    // И НИКОГДА не публикуем сами пост с невыверенной конкретикой. Выдуманный номер статьи
    // в канале юриста — это профессиональный риск, а не «неточность»: пусть человек решит
    // сам. Автопилот тут молчит именно потому, что цена ошибки высокая.
    if (full && aiDraft && qualityResult.passed) {
      const t = new Date(scheduledAt).getTime();
      if (t < Date.now() + 60_000) scheduledAt = new Date(Date.now() + 120_000).toISOString();
      item.scheduledAt = scheduledAt;
      item.postId = await enqueuePost(userId, ch.id, draft, scheduledAt);
      item.status = "approved";
    }
    return item;
  });

  const anyPending = items.some((it) => it.status === "pending");
  const planStatus = full && !anyPending ? "approved" : "pending";

  // Снести старый план и вставить новый — одной транзакцией. Порознь это ловушка: если
  // между delete и insert что-то падает (а вставка стала строже — канал теперь обязателен),
  // человек остаётся вообще без плана. Так и вышло на моих же тестах: старый воркер удалил
  // оба плана и не смог вставить свой.
  const tx = await pool.connect();
  let ins;
  try {
    await tx.query("begin");
    // The settings row is the per-channel mutex also used by POST /api/autopilot/generate.
    // It closes the race where an old worker finishes just as the user starts a new build.
    await tx.query(
      `select 1 from autopilot_settings
        where user_id = $1 and channel_id = $2 for update`,
      [userId, channelId],
    );
    const building = (
      await tx.query(
        `select id from autopilot_plan
          where user_id = $1 and channel_id = $2 and status = 'building'
          order by created_at desc limit 1`,
        [userId, channelId],
      )
    ).rows[0];
    if (
      (expectedPlanId != null && String(building?.id) !== String(expectedPlanId)) ||
      (expectedPlanId == null && building)
    ) {
      await tx.query("rollback");
      console.log(
        expectedPlanId != null
          ? `[auto] plan ${expectedPlanId}: появился более новый запуск — результат отброшен`
          : `[auto] user ${userId}/${channelId}: ручная сборка уже идёт — недельный запуск пропущен`,
      );
      return { superseded: true };
    }
    await tx.query(`delete from autopilot_plan where user_id = $1 and channel_id = $2`, [
      userId,
      channelId,
    ]);
    ins = await tx.query(
      `insert into autopilot_plan (user_id, channel_id, week_start, items, rules, status)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [userId, channelId, mskDatePlus(1), JSON.stringify(items), rule, planStatus],
    );
    await tx.query("commit");
  } catch (err) {
    await tx.query("rollback").catch(() => {});
    throw err;
  } finally {
    tx.release();
  }

  // «Одобрение недельного плана одной кнопкой» — это обещание ТЗ. Серверная часть была
  // готова давно (атомарная заявка от гонок), не хватало ровно кнопки.
  const who = ch.title ? ` — ${ch.title}` : "";
  const blockedCount = items.filter((it) => it.qualityBlocked).length;
  const readyCount = items.filter((it) => it.status === "pending" && !it.qualityBlocked).length;
  const planText =
    planStatus === "approved"
      ? `🚀 Автопилот (полный режим)${who}: ${N} ${plural(N, "пост", "поста", "постов")} на неделю уже в очереди.\n${rule}`
      : full && anyPending
        ? `🗓 План собран${who}, но ИИ был недоступен для части постов — их надо подтвердить вручную.`
        : blockedCount
          ? `🗓 План собран${who}: ${readyCount} готовы, ${blockedCount} ${plural(blockedCount, "пост заблокирован", "поста заблокированы", "постов заблокированы")} редакционным контролем.`
          : `🗓 План на неделю готов${who}: ${N} ${plural(N, "пост", "поста", "постов")}.\n${rule}`;
  const planBtns =
    planStatus === "pending" && readyCount > 0
      ? [[{ text: `Одобрить готовые (${readyCount})`, data: `plan:approve:${ins.rows[0].id}` }]]
      : undefined;
  // Нет привязанного чата — выбор пользователя, владельцу чужой план не шлём (была утечка).
  await notifyUser(userId, planText, planBtns);

  // ── Gap-доспрос: план собран, и теперь видно, чего ИИ не хватило ──
  // 1) База фактов пуста совсем — спрашиваем про услуги и цены одним вопросом.
  // 2) Из постов пришлось убрать непроверенную конкретику — спрашиваем точные цифры.
  // Оба вопроса дедупятся (та же тема — раз в 14 дней) и не накладываются (maybeAskGap).
  if (!facts) {
    await maybeAskGap(
      userId,
      channelId,
      "empty-base",
      "Собрал план на неделю, но о твоём бизнесе знаю пока мало — поэтому пишу без цен и сроков, чтобы не наврать. Расскажи одним сообщением: что предлагаешь и сколько это стоит? Запомню и буду использовать в постах.",
    );
  } else {
    const missing = items
      .filter((it) => it.invented?.length)
      .flatMap((it) => it.invented)
      .slice(0, 3);
    if (missing.length) {
      await maybeAskGap(
        userId,
        channelId,
        "plan-facts",
        `Писал посты и убрал из них конкретику, которой нет в твоих материалах: ${missing.map((m) => `«${m}»`).join(", ")}. Как будет верно? Одним сообщением — запомню и больше не уберу.`,
      );
    }
  }

  console.log(`[auto] user ${userId}/${channelId}: план на ${N} постов собран (${planStatus})`);
  return { id: ins.rows[0].id, count: N };
}

// Снять ещё не вышедшие (scheduled) посты прошлого плана и их отложенные задачи —
// чтобы пересборка/недельный автопилот не публиковали дубли (ревью Д.9).
async function cancelPreviousPlan(userId, channelId) {
  const prev = (
    await pool.query(
      `select items from autopilot_plan
        where user_id = $1 and channel_id = $2 and status in ('pending', 'approved')
        order by created_at desc limit 1`,
      [userId, channelId],
    )
  ).rows[0];
  if (!prev?.items) return;
  for (const it of prev.items) {
    if (!it.postId) continue;
    const job = await queue.getJob(`post-${it.postId}`).catch(() => null);
    if (job) await job.remove().catch(() => {});
    await pool
      .query(`delete from posts where id = $1 and status = 'scheduled'`, [it.postId])
      .catch(() => {});
  }
}

// Вставить scheduled-пост и положить задачу в очередь публикации (для полного режима автопилота).
async function enqueuePost(userId, channelId, text, scheduledAt) {
  const ins = await pool.query(
    `insert into posts (user_id, channel_id, text, scheduled_at, status)
     values ($1, $2, $3, $4, 'scheduled') returning id`,
    [userId, channelId, text, scheduledAt],
  );
  const postId = ins.rows[0].id;
  const delay = Math.max(0, new Date(scheduledAt).getTime() - Date.now());
  try {
    await queue.add(
      "publish",
      { postId },
      { delay, jobId: `post-${postId}`, removeOnComplete: true, removeOnFail: false },
    );
  } catch (err) {
    // Не оставляем в БД scheduled-пост без BullMQ job: вызывающий сможет безопасно повторить.
    await pool.query(`delete from posts where id = $1 and status = 'scheduled'`, [postId]).catch(() => {});
    throw err;
  }
  return postId;
}

// Раз в неделю — планы для КАЖДОГО канала, где автопилот включён. Включённость теперь
// свойство канала: можно вести один канал на автопилоте, а второй руками — и наоборот.
// Канал, который человек отключил (is_active = false), планы не получает.
async function weeklyPlans() {
  const targets = (
    await pool.query(
      `select s.user_id, s.channel_id from autopilot_settings s
         join channels c on c.id = s.channel_id and c.is_active = true
        where s.enabled = true order by s.user_id, s.channel_id`,
    )
  ).rows;
  for (const t of targets) {
    try {
      await buildAutopilotPlan(t.user_id, t.channel_id);
    } catch (err) {
      console.error(`[auto] user ${t.user_id}/канал ${t.channel_id} план упал:`, err?.message);
    }
  }
}

// ============================================================================
// БОТ: что делают команды и кнопки. Живёт здесь — ниже автопилота и разведки,
// чтобы переиспользовать их функции, а не дублировать логику.
// ============================================================================

/** Короткая сводка по каналу — то же, что видно в «Аналитике», но за 2 секунды в телефоне. */
async function botStats(userId) {
  const chans = (
    await pool.query(
      `select id, title from channels where user_id = $1 and network = 'tg' and is_active = true
        order by id`,
      [userId],
    )
  ).rows;
  if (!chans.length)
    return "Канал ещё не подключён. Открой Аврору → «Настройки» → подключи канал, и я начну приносить цифры.";

  // По каналу — раздельно. Раньше здесь был `limit 1`: в заголовке стояло имя первого канала,
  // а посты считались по всему аккаунту. У кого два канала — тому бот показывал сумму под
  // именем одного из них. Это не «неточность», это неправда, а цифрам должно быть можно верить.
  const blocks = [];
  for (const ch of chans) {
    const s = (
      await pool.query(
        `select count(*)::int as posts,
                coalesce(sum(ps.views), 0)::int as views,
                coalesce(round(avg(ps.views)), 0)::int as avg
           from posts p
           left join lateral (
             select views from post_stats where post_id = p.id order by snapshot_date desc limit 1
           ) ps on true
          where p.user_id = $1 and p.channel_id = $2 and p.status = 'published'
            and p.published_at > now() - interval '7 days'`,
        [userId, ch.id],
      )
    ).rows[0];

    const subs = (
      await pool.query(
        `select subscribers, subscribers_delta from channel_stats
          where channel_id = $1 order by snapshot_date desc limit 1`,
        [ch.id],
      )
    ).rows[0];

    const lines = [`📊 «${ch.title || "канал"}» за неделю`];
    lines.push(`Постов: ${s.posts}`);
    if (s.views > 0) lines.push(`Просмотров: ${s.views} (в среднем ${s.avg} на пост)`);
    else if (s.posts > 0) lines.push(`Просмотры ещё не собрались — обычно появляются в течение суток.`);
    if (subs) {
      const d = subs.subscribers_delta;
      lines.push(`Подписчиков: ${subs.subscribers}${d ? ` (${d > 0 ? "+" : ""}${d} за день)` : ""}`);
    }
    if (s.posts === 0) lines.push("Постов на этой неделе не было — как выйдет первый, пришлю цифры.");
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/** План недели с кнопкой одобрения — то самое «одобрение одной кнопкой» из ТЗ. */
async function botPlan(userId) {
  // По плану на канал — свежий у каждого. Кнопка одобрения несёт id плана, поэтому она
  // всегда одобряет ровно тот канал, под которым нарисована.
  const plans = (
    await pool.query(
      `select distinct on (p.channel_id) p.id, p.items, p.rules, p.status, c.title
         from autopilot_plan p
         join channels c on c.id = p.channel_id and c.is_active = true
        where p.user_id = $1 and p.status in ('pending', 'approved')
        order by p.channel_id, p.created_at desc`,
      [userId],
    )
  ).rows;
  if (!plans.length) return { text: "Плана пока нет. Включи автопилот в Авроре — и я соберу неделю." };

  const many = plans.length > 1;
  const chunks = [];
  const buttons = [];
  for (const plan of plans) {
    const items = plan.items || [];
    const pending = items.filter((i) => i.status === "pending").length;
    const head = many ? `🗓 «${plan.title || "канал"}»` : "🗓 План на неделю";
    const lines = [`${head}: ${items.length} ${plural(items.length, "пост", "поста", "постов")}`];
    if (plan.rules) lines.push(plan.rules);
    lines.push("");
    for (const it of items.slice(0, 7)) {
      const mark = it.status === "approved" ? "✅" : it.status === "rejected" ? "✖️" : "•";
      lines.push(`${mark} ${new Date(it.scheduledAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} — ${it.topic}`);
    }
    chunks.push(lines.join("\n"));
    if (pending > 0)
      buttons.push([
        {
          text: many ? `Одобрить «${plan.title || "канал"}» (${pending})` : `Одобрить всё (${pending})`,
          data: `plan:approve:${plan.id}`,
        },
      ]);
  }
  return { text: chunks.join("\n\n"), buttons: buttons.length ? buttons : undefined };
}

/** Что зашло у соседей по нише — верх той же ленты, что в «Сними это». */
async function botTrends(userId) {
  const rows = (
    await pool.query(
      `with mature as (
         select cp.id, cp.tg_msg_id, cp.text, cp.views, c.handle, c.title
           from competitor_posts cp
           join competitors c on c.id = cp.competitor_id
           join channels och on och.id = c.channel_id and och.user_id = $1
          where c.network = 'tg'
            and cp.views is not null and cp.posted_at is not null
            and cp.posted_at < now() - interval '48 hours'
       ),
       med as (
         select handle, percentile_cont(0.5) within group (order by views) as m, count(*)::int as n
           from mature group by handle
       )
       select x.*, round((x.views / d.m)::numeric, 1) as ratio
         from mature x join med d on d.handle = x.handle
        where d.n >= 5 and d.m > 0
        order by ratio desc limit 3`,
      [userId],
    )
  ).rows;

  if (!rows.length) {
    return { text: "Пока нечего показать: добавь конкурентов в Авроре, и я начну ловить, что у них заходит." };
  }
  const lines = ["🔥 Что зашло у соседей по нише:"];
  for (const r of rows) {
    lines.push(`\n×${r.ratio} к норме — «${r.title || r.handle}»`);
    lines.push((r.text || "пост без текста").replace(/\s+/g, " ").slice(0, 110));
    lines.push(`https://t.me/${r.handle}/${r.tg_msg_id}`);
  }
  return {
    text: lines.join("\n"),
    buttons: [[{ text: "Сними лучший", data: `idea:${rows[0].id}` }]],
  };
}

/** Кнопка «Отправить снова» на упавшем посте — без похода в приложение. */
async function botRetry(userId, postId) {
  const upd = await pool.query(
    `update posts set status = 'scheduled', last_error = null
      where id = $1 and user_id = $2 and status in ('failed', 'publishing')
      returning id`,
    [postId, userId],
  );
  if (!upd.rowCount) return "Этот пост уже не нуждается в повторе.";
  await queue.add(
    "publish",
    { postId },
    { jobId: `post-${postId}-bot-${Date.now()}`, removeOnComplete: true },
  );
  return "Поставил в очередь — сейчас попробую снова.";
}

/** Кнопка «Одобрить всё»: та же атомарная заявка плана, что и в кабинете (защита от гонки). */
async function botApprovePlan(userId, planId) {
  const claim = await pool.query(
    `update autopilot_plan set status = 'approving'
      where id = $1 and user_id = $2 and status = 'pending'
      returning id, items, channel_id`,
    [planId, userId],
  );
  if (!claim.rowCount) return "Этот план уже одобрен.";

  const plan = claim.rows[0];
  // Канал берём из плана: кнопка одобряет ровно тот канал, под которым нарисована.
  const ch = (
    await pool.query(
      `select id, title from channels where id = $1 and is_active = true`,
      [plan.channel_id],
    )
  ).rows[0];
  if (!ch) {
    await pool.query(`update autopilot_plan set status = 'pending' where id = $1`, [planId]);
    return "Канал отключён — публиковать некуда.";
  }

  const items = plan.items;
  let n = 0;
  try {
    for (const it of items) {
      if (it.status !== "pending" || it.postId) continue;
      if (it.qualityBlocked) continue;
      const t = new Date(it.scheduledAt).getTime();
      const at = t < Date.now() + 60_000 ? new Date(Date.now() + 120_000).toISOString() : it.scheduledAt;
      it.postId = await enqueuePost(userId, ch.id, it.draft, at);
      it.scheduledAt = at;
      it.status = "approved";
      n++;
    }
  } catch (err) {
    // Не оставляем план в 'approving' навсегда: иначе кнопка мертва, а посты уже в очереди.
    await pool.query(`update autopilot_plan set items = $2, status = 'pending' where id = $1`, [
      planId,
      JSON.stringify(items),
    ]);
    console.error("[bot] одобрение плана упало:", err?.message);
    return "Что-то пошло не так — часть постов уже в очереди. Открой Аврору и проверь план.";
  }

  const blocked = items.filter((it) => it.status === "pending" && it.qualityBlocked).length;
  await pool.query(`update autopilot_plan set items = $2, status = $3 where id = $1`, [
    planId,
    JSON.stringify(items),
    blocked ? "pending" : "approved",
  ]);
  // Одобрение без правок — заслуга ЭТОГО канала: полный режим открывается на нём, а не разом
  // на всех. То же правило, что и в кабинете (/api/autopilot/approve).
  await pool.query(
    `update autopilot_settings
        set approvals_streak = case when $3 then approvals_streak + 1 else 0 end, updated_at = now()
      where user_id = $1 and channel_id = $2`,
    [userId, plan.channel_id, n > 0 && blocked === 0],
  );
  const who = ch.title ? ` — «${ch.title}»` : "";
  return blocked
    ? `Готово${who}: ${n} в очереди, ${blocked} ${plural(blocked, "пост заблокирован", "поста заблокированы", "постов заблокированы")} проверкой качества.`
    : `Готово${who} — ${n} ${plural(n, "пост", "поста", "постов")} в очереди.`;
}

/** Кнопка «Сними это»: ИИ пишет пост по залёту конкурента прямо в чат. */
async function botIdea(userId, competitorPostId) {
  const p = (
    await pool.query(
      `select cp.text, c.title, c.handle from competitor_posts cp
         join competitors c on c.id = cp.competitor_id
        where cp.id = $1 and c.user_id = $2`,
      [competitorPostId, userId],
    )
  ).rows[0];
  if (!p) return null;

  const mood = await userMood(userId);
  const samples = (
    await pool.query(
      `select text from posts where user_id = $1 and status = 'published'
        and length(trim(text)) > 0 order by published_at desc limit 8`,
      [userId],
    )
  ).rows.map((r) => r.text);

  const draft = await askAI(
    postSystem(samples) + "\n" + moodPromptW(mood),
    `У соседа по нише «${p.title || p.handle}» зашёл пост:\n"""${(p.text || "").replace(/\s+/g, " ").slice(0, 400)}"""\n` +
      `Напиши МОЙ пост на эту тему — не копию, свой угол.`,
    350,
    mood,
  );
  return draft;
}

/** Одно обновление от Telegram. Никогда не бросает: упавший апдейт не должен ронять поллинг. */
async function handleUpdate(u) {
  try {
    if (u.message?.text) {
      const chatId = u.message.chat.id;
      const text = u.message.text.trim();

      if (text.startsWith("/start")) return handleStart(chatId, text.split(/\s+/)[1] || null);

      const userId = await userByChat(chatId);
      if (!userId) {
        await tgSend(chatId, "Мы ещё не знакомы. Открой «Настройки» в Авроре и нажми «Подключить бота».");
        return;
      }

      if (text.startsWith("/stats")) return void (await tgSend(chatId, await botStats(userId)));
      if (text.startsWith("/plan")) {
        const p = await botPlan(userId);
        return void (await tgSend(chatId, p.text, p.buttons));
      }
      if (text.startsWith("/trends")) {
        const t = await botTrends(userId);
        return void (await tgSend(chatId, t.text, t.buttons));
      }
      if (text.startsWith("/help")) {
        return void (await tgSend(
          chatId,
          "Я слежу за твоим каналом и приношу новости:\n\n" +
            "/stats — цифры за неделю\n/plan — план недели, с кнопкой одобрения\n/trends — что зашло у соседей\n\n" +
            "Сам напишу, когда пост выйдет, упадёт или у конкурента что-то залетит.",
        ));
      }
      // Свободный текст без команды — скорее всего ответ на gap-вопрос (ИИ спросил
      // о пробеле в знаниях). Короткое «ок» фактом не считаем: пользы с двух букв нет.
      const gap = text.startsWith("/") ? null : await pendingGap(userId);
      if (gap) {
        if (text.length < 10) {
          return void (await tgSend(
            chatId,
            "Чуть подробнее, пожалуйста — одним сообщением, от 10 символов. " +
              "Или нажми «Отвечу позже» под моим вопросом.",
          ));
        }
        await saveGapAnswer(userId, gap, text);
        return void (await tgSend(
          chatId,
          "Записал и запомнил 🧠 Теперь буду использовать это в постах — без выдумок.",
        ));
      }
      await tgSend(chatId, "Не понял. Жми «/» — там список команд.");
      return;
    }

    if (u.callback_query) {
      const cb = u.callback_query;
      const chatId = cb.message?.chat?.id;
      const userId = chatId ? await userByChat(chatId) : null;
      // Кнопка «Одобрить всё» публикует в живой канал — принимаем только от привязанного чата.
      if (!userId) return void (await answerCb(cb.id, "Чат не привязан к аккаунту"));

      const [kind, action, id] = String(cb.data || "").split(":");

      if (kind === "retry") return void (await answerCb(cb.id, await botRetry(userId, Number(action))));
      if (kind === "plan" && action === "approve") {
        return void (await answerCb(cb.id, await botApprovePlan(userId, Number(id))));
      }
      if (kind === "gap" && action === "skip") {
        const r = await pool.query(
          `update gap_questions set status = 'skipped'
            where id = $1 and user_id = $2 and status = 'pending'`,
          [Number(id), userId],
        );
        return void (await answerCb(cb.id, r.rowCount ? "Хорошо, спрошу позже" : "Вопрос уже закрыт"));
      }
      if (kind === "idea") {
        await answerCb(cb.id, "Пишу…");
        const draft = await botIdea(userId, Number(action));
        await tgSend(
          chatId,
          draft ? `✍️ Твой пост на эту тему:\n\n${draft}` : "ИИ сейчас недоступен — загляни в Аврору, там есть студия.",
        );
        return;
      }
      await answerCb(cb.id, "Кнопка устарела");
    }
  } catch (err) {
    console.error("[bot] обновление упало:", err?.message);
  }
}

/** Длинный опрос. Смещение — в базе: после рестарта Telegram отдал бы старые нажатия заново. */
async function pollUpdates() {
  if (!TOKEN || !BOT_POLL) return;
  await tg("setMyCommands", { commands: BOT_COMMANDS }).catch(() => {});
  console.log("[bot] слушаю команды и кнопки (long polling, webhook не нужен)");

  for (;;) {
    try {
      const offset =
        Number((await pool.query(`select last_update from bot_state where id = 1`)).rows[0]?.last_update ?? 0) + 1;
      // timeout=30 — соединение висит и ждёт события: это не «опрос раз в секунду», а push.
      const r = await tg("getUpdates", { offset, timeout: 30 }, 40_000);
      if (!r?.ok) {
        if (/conflict/i.test(r?.description || "")) {
          console.error("[bot] конфликт: кто-то ещё слушает этого бота (webhook или второй воркер). Пауза 60с.");
          await sleep(60_000);
        } else {
          await sleep(5_000);
        }
        continue;
      }
      for (const u of r.result) {
        await handleUpdate(u);
        await pool.query(`update bot_state set last_update = $1, updated_at = now() where id = 1`, [
          u.update_id,
        ]);
      }
    } catch (err) {
      // Таймаут длинного опроса — это норма, а не ошибка: молча идём на следующий круг.
      if (!/timeout|aborted/i.test(err?.message || "")) {
        console.error("[bot] поллинг:", err?.message);
        await sleep(5_000);
      }
    }
  }
}

// Отдельная очередь ручных задач аналитики (кнопка «обновить», недельный отчёт) и разведки.
const statsWorker = MEDIA_ONLY ? null : new Worker(
  "stats",
  async (job) => {
    if (job.name === "collect") {
      await collectStats();
    } else if (job.name === "report") {
      const userId = Number(job.data.userId);
      if (!Number.isInteger(userId) || userId <= 0) throw new Error("report: bad userId");
      const delivered = await notifyUser(userId, await buildWeeklyReport(pool, userId));
      console.log(
        delivered
          ? `[stats] недельный отчёт отправлен user ${userId}`
          : `[stats] недельный отчёт НЕ доставлен user ${userId} — бот не привязан или недоступен`,
      );
      if (!delivered) throw new Error("недельный отчёт не доставлен"); // пусть очередь повторит
    } else if (job.name === "competitor") {
      // Первичный сбор сразу после добавления — досье готово за секунды, а не за час.
      const c = (
        await pool.query(`select id, user_id, handle, title from competitors where id = $1`, [job.data.id])
      ).rows[0];
      if (c) await collectCompetitor(c);
    } else if (job.name === "rss-now") {
      // Кнопка «Проверить сейчас» на экране RSS: человек не ждёт получасового крона —
      // собираем все его активные ленты немедленно (collectRss сама соблюдает лимиты).
      const userId = Number(job.data.userId);
      if (!Number.isInteger(userId) || userId <= 0) throw new Error("rss-now: bad userId");
      await collectRss(userId);
    } else if (job.name === "knowledge-index") {
      // Человек добавил материал в базу знаний — считаем векторы сейчас, а не суточным
      // циклом: он вернётся на экран через минуту и должен увидеть «готово».
      const r = await indexSource(job.data.sourceId);
      if (r?.error && r.error !== "empty") throw new Error(r.error);
    } else if (job.name === "discover") {
      // Человек нажал «Найти соседей» — идём по графу ниши сейчас. Канал указан (подключили
      // новый — ищем соседей ему) или нет (кнопка в кабинете — обходим все каналы).
      if (job.data.channelId) await discoverForChannel(job.data.userId, job.data.channelId);
      else await discoverForUser(job.data.userId);
    } else if (job.name === "autopilot-plan") {
      // Пользователь нажал «Собрать план» — строим сейчас (Д.9). При любом сбое переводим
      // застрявший 'building'-план в 'error', чтобы интерфейс не крутил спиннер вечно (ревью).
      const { userId, channelId } = job.data;
      // Jobs created before planId was introduced are still safe: bind the first processed item
      // to the current placeholder. Once it succeeds, the remaining duplicates find nothing
      // and become no-ops instead of rebuilding the channel again.
      let planId = Number(job.data.planId);
      if (!Number.isInteger(planId) || planId <= 0) {
        const current = (
          await pool.query(
            `select id from autopilot_plan
              where user_id = $1 and channel_id = $2 and status = 'building'
              order by created_at desc limit 1`,
            [userId, channelId],
          )
        ).rows[0];
        planId = Number(current?.id);
        if (!Number.isInteger(planId) || planId <= 0) return;
      }
      try {
        const r = await buildAutopilotPlan(userId, channelId, planId);
        if (r?.error) throw new Error(r.error);
      } catch (err) {
        // Only the placeholder owned by this job. An older failed job must never turn a newer
        // retry for the same channel into `error`.
        await pool
          .query(
            `update autopilot_plan set status = 'error'
              where id = $1 and user_id = $2 and channel_id = $3 and status = 'building'`,
            [planId, userId, channelId],
          )
          .catch(() => {});
        throw err;
      }
    }
  },
  { connection },
);
statsWorker?.on("error", (err) => console.error("[stats] ошибка:", err));

// ----------------------------------------------------------------------------
// Крон на BullMQ-планировщиках (заменил setInterval). Таймеры в памяти процесса не
// переживали рестарт: при деплоях чаще раза в неделю недельный план (шаг 7 дней от старта)
// не срабатывал НИКОГДА. Планировщики BullMQ хранятся в Redis, идемпотентны (upsert) и
// стреляют по расписанию независимо от времени запуска процесса.
//
// Очередь отдельная (не publish/stats), concurrency: 1 — плановые проходы НЕ накладываются
// друг на друга: долгая разведка не запустит вторую копию себя по следующему тику.
// Чистка протухших данных: завершившиеся сессии и использованные/просроченные bot_links.
// Без этого таблицы бесконечно растут мёртвыми строками. Идемпотентные delete — безопасно.

// ── Нишевой радар: алерты по ключевым словам ────────────────────────────────────
// После сбора конкурентов проверяем: есть ли новые посты, попадающие под активные алерты?
// Используем полнотекст (tsv) по competitor_posts. Совпадения пишем в niche_matches,
// уведомляем юзера в бота (один раз на алерт за цикл).
async function checkNicheAlerts() {
  const alerts = (
    await pool.query(
      `select a.id, a.user_id, a.channel_id, a.keyword
         from niche_alerts a where a.is_active = true`,
    )
  ).rows;
  if (!alerts.length) return;

  let total = 0;
  for (const alert of alerts) {
    try {
      // Ищем посты конкурентов юзера, совпадающие с keyword (полнотекст)
      const matches = await pool.query(
        `insert into niche_matches (alert_id, competitor_post_id)
         select $1, cp.id
           from competitor_posts cp
           join competitors c on c.id = cp.competitor_id and c.user_id = $2
          where cp.tsv @@ plainto_tsquery('russian', $3)
            and cp.collected_at > now() - interval '3 hours'
            and not exists (
              select 1 from niche_matches nm
               where nm.alert_id = $1 and nm.competitor_post_id = cp.id
            )
         on conflict do nothing
         returning competitor_post_id`,
        [alert.id, alert.user_id, alert.keyword],
      );
      if (!matches.rowCount) continue;
      total += matches.rowCount;

      // Уведомляем юзера (один пуш на алерт за цикл)
      const sample = await pool.query(
        `select cp.text, c.title, c.handle
           from competitor_posts cp
           join competitors c on c.id = cp.competitor_id
          where cp.id = $1`,
        [matches.rows[0].competitor_post_id],
      );
      const post = sample.rows[0];
      const snippet = (post?.text || "").slice(0, 150);
      await notifyUser(
        alert.user_id,
        `🔔 <b>Радар: «${alert.keyword}»</b>\n\n${post?.title || "@" + post?.handle}: ${snippet}…\n\nНайдено совпадений: ${matches.rowCount}`,
      );
      await pool.query(
        `update niche_alerts set last_notified_at = now() where id = $1`,
        [alert.id],
      );
      await pool.query(
        `update niche_matches set notified = true where alert_id = $1 and notified = false`,
        [alert.id],
      );
    } catch (err) {
      console.error(`[radar] алерт ${alert.id} (${alert.keyword}):`, err?.message);
    }
  }
  if (total) console.log(`[radar] совпадений по алертам: ${total}`);
}

// ── Мониторинг упоминаний MVP ────────────────────────────────────────────────
// Для каждого активного query: VK newsfeed.search + TG t.me/s/ конкурентов.
// Новые упоминания пишем в mentions, пушим в бота.
async function collectMentions() {
  const queries = (
    await pool.query(
      `select mq.id, mq.user_id, mq.channel_id, mq.keyword, mq.networks
         from mention_queries mq where mq.is_active = true`,
    )
  ).rows;
  if (!queries.length) return;

  let total = 0;
  for (const mq of queries) {
    try {
      const networks = mq.networks || ["tg", "vk"];

      // ── VK: newsfeed.search ──
      if (networks.includes("vk")) {
        const ch = (
          await pool.query(
            `select vk_token, user_id from channels where id = $1 and vk_token is not null`,
            [mq.channel_id],
          )
        ).rows[0];
        if (ch?.vk_token) {
          try {
            const token = decryptToken(ch.vk_token, { userId: ch.user_id, provider: "vk" });
            const res = await vkApi("newsfeed.search", { q: mq.keyword, count: 20 }, token);
            const items = res?.response?.items ?? [];
            for (const item of items) {
              const postId = item.id;
              const ownerId = item.owner_id;
              const postUrl = ownerId < 0
                ? `https://vk.com/wall-${Math.abs(ownerId)}_${postId}`
                : `https://vk.com/wall${ownerId}_${postId}`;
              const ins = await pool.query(
                `insert into mentions (query_id, network, source_handle, post_url, text, posted_at)
                 values ($1, 'vk', $2, $3, $4, to_timestamp($5))
                 on conflict (query_id, network, post_url) do nothing
                 returning id`,
                [mq.id, String(ownerId), postUrl, (item.text || "").slice(0, 2000), item.date],
              );
              if (ins.rowCount) total++;
            }
          } catch { /* VK недоступен — пропускаем */ }
        }
      }

      // ── TG: парсим t.me/s/ конкурентов юзера на вхождение keyword ──
      if (networks.includes("tg")) {
        const comps = (
          await pool.query(
            `select handle, title from competitors where user_id = $1 and network = 'tg' and status = 'ready' limit 30`,
            [mq.user_id],
          )
        ).rows;
        const kw = mq.keyword.toLowerCase();
        for (const comp of comps) {
          try {
            const page = await fetchCompetitorPage(comp.handle);
            if (!page.ok) continue;
            for (const p of page.posts) {
              if (!(p.text || "").toLowerCase().includes(kw)) continue;
              const postUrl = `https://t.me/${comp.handle}/${p.msgId}`;
              const ins = await pool.query(
                `insert into mentions (query_id, network, source_handle, source_title, post_url, text, posted_at)
                 values ($1, 'tg', $2, $3, $4, $5, $6)
                 on conflict (query_id, network, post_url) do nothing
                 returning id`,
                [mq.id, comp.handle, comp.title || comp.handle, postUrl, (p.text || "").slice(0, 2000), p.postedAt],
              );
              if (ins.rowCount) total++;
            }
          } catch { /* канал недоступен */ }
        }
      }

      await pool.query(`update mention_queries set last_checked_at = now() where id = $1`, [mq.id]);
    } catch (err) {
      console.error(`[mentions] query ${mq.id} (${mq.keyword}):`, err?.message);
    }
  }

  // Пушим новые упоминания в бота
  if (total) {
    const unnotified = (
      await pool.query(
        `select m.id, m.query_id, m.network, m.source_handle, m.source_title, m.text, m.post_url,
                mq.user_id, mq.keyword
           from mentions m
           join mention_queries mq on mq.id = m.query_id
          where m.notified = false
          order by m.found_at desc limit 20`,
      )
    ).rows;
    for (const mention of unnotified) {
      const src = mention.source_title || mention.source_handle || mention.network;
      const snippet = (mention.text || "").slice(0, 120);
      await notifyUser(
        mention.user_id,
        `💬 <b>Упоминание: «${mention.keyword}»</b>\n\n${src}: ${snippet}…\n\n${mention.post_url || ""}`,
      ).catch(() => {});
      await pool.query(`update mentions set notified = true where id = $1`, [mention.id]);
    }
    console.log(`[mentions] найдено упоминаний: ${total}`);
  }
}

// ── RSS-репостер ────────────────────────────────────────────────────────────────
// Для каждого активного фида: fetch XML → parseRss → новые записи в rss_items →
// если ai_summarize → ИИ-суммаризация → создать пост (scheduled) → обновить статус.
async function collectRss(userId = null) {
  return collectRssPipeline({
    pool,
    userId,
    enqueuePost,
    summarize: (item) =>
      askAI(
        "Ты — редактор канала. Суммаризируй новость в короткий пост. Живо, на русском, без хэштегов.\n" +
          "Формат: хук одной строкой, затем 2–3 коротких абзаца по 1–2 предложения, между абзацами пустая строка. В конце — вывод или вопрос читателю.",
        `Заголовок: ${item.title}\n\nТекст: ${item.summary.slice(0, 1500)}`,
        300,
      ),
  });
}

// ── Еженедельное переизвлечение профиля (невидимая база знаний) ──────────────────
// Канал живёт: услуги, цены и темы меняются. Раз в неделю перечитываем ленту и
// обновляем АВТО-профиль (kind='profile'). Профиль, который человек подтвердил или
// правил руками (kind='profile_edit'), обходим стороной — его слова важнее выжимки.
async function refreshProfiles() {
  const channels = (
    await pool.query(
      `select c.id, c.user_id, c.handle, c.title
         from channels c
        where c.network = 'tg' and c.handle is not null and c.is_active
          and exists (select 1 from knowledge_sources ks
                       where ks.channel_id = c.id and ks.kind = 'profile')
          and not exists (select 1 from knowledge_sources ks
                           where ks.channel_id = c.id and ks.kind = 'profile_edit')`,
    )
  ).rows;
  if (!channels.length) return;

  let updated = 0;
  await mapConcurrent(channels, 2, async (ch) => {
    try {
      const page = await fetchCompetitorPage(ch.handle);
      const posts = (page.posts || [])
        .map((p) => (p.text || "").trim())
        .filter((t) => t.length >= 40);
      // Лента закрылась или обмельчала — старый профиль честнее пустоты.
      if (posts.length < 3) return;

      const { system, user } = buildExtractionMessages(ch.title || ch.handle, posts);
      const raw = await askAI(system, user, 700, null, 0.2);
      const profile = raw && parseProfile(raw);
      // Движок лёг или вернул мусор — тоже оставляем старый профиль.
      if (!profile) return;

      await pool.query(`delete from knowledge_sources where channel_id = $1 and kind = 'profile'`, [ch.id]);
      const ins = await pool.query(
        `insert into knowledge_sources (user_id, channel_id, kind, title, raw_text)
         values ($1, $2, 'profile', $3, $4) returning id`,
        [ch.user_id, ch.id, `Профиль канала «${ch.title || ch.handle}»`, profileToSourceText(profile)],
      );
      await indexSource(Number(ins.rows[0].id));
      updated++;
    } catch (err) {
      console.error(`[profile] канал ${ch.id}:`, err?.message);
    }
  });
  console.log(`[profile] переизвлечено профилей: ${updated}/${channels.length}`);
}

async function cleanupExpired() {
  const sessions = await pool.query(`delete from sessions where expires_at < now()`);
  const links = await pool.query(
    `delete from bot_links where used_at is not null or expires_at < now()`,
  );
  console.log(
    `[cleanup] удалено: сессий — ${sessions.rowCount}, bot_links — ${links.rowCount}`,
  );
}

const cronQueue = AUTOPILOT_ONLY || MEDIA_ONLY ? null : new Queue("cron", { connection });

// Расписания в московском времени. trend сдвинут на 15 мин относительно recon, чтобы не
// долбить t.me обеими задачами в одну секунду.
const CRON_SCHEDULES = [
  { name: "stats",    pattern: "0 1 * * *" },    // суточный снимок аналитики, 01:00 МСК
  { name: "recon",    pattern: "0 */2 * * *" },  // разведка конкурентов, каждые 2ч
  { name: "trend",    pattern: "15 */2 * * *" }, // насмотренность, каждые 2ч (сдвиг 15мин от recon)
  { name: "discover", pattern: "0 4 * * *" },    // поиск соседей по нише, 04:00 МСК
  { name: "weekly",   pattern: "0 21 * * 0" },   // недельные планы, вс 21:00 МСК
  { name: "cleanup",  pattern: "0 3 * * *" },    // чистка протухших sessions/bot_links, 03:00 МСК
  { name: "rss",      pattern: "*/30 * * * *" }, // RSS-ленты, каждые 30 мин
  { name: "mentions", pattern: "30 */1 * * *" }, // упоминания, каждый час в :30
  { name: "profile",  pattern: "0 5 * * 1" },   // переизвлечение профилей каналов, пн 05:00 МСК
];

const cronWorker = AUTOPILOT_ONLY || MEDIA_ONLY ? null : new Worker(
  "cron",
  async (job) => {
    switch (job.name) {
      case "stats":    await collectStats(); return collectVkStats();
      case "recon":    await collectCompetitors(); return checkNicheAlerts();
      case "trend":    return collectTrendSources();
      case "discover": return discoverAll();
      case "weekly":   return weeklyPlans();
      case "cleanup":  return cleanupExpired();
      case "rss":      return collectRss();
      case "mentions": return collectMentions();
      case "profile":  return refreshProfiles();
      default:         console.warn(`[cron] неизвестная задача: ${job.name}`);
    }
  },
  { connection, concurrency: 1 },
);
cronWorker?.on("failed", (job, err) => console.error(`[cron] ${job?.name} упала:`, err?.message));
cronWorker?.on("error", (err) => console.error("[cron] ошибка:", err));

// Восстановление после падения/деплоя (ревью, критично): пост, застрявший в 'publishing'
// (процесс убили во время отправки), иначе теряется навсегда. Но он МОГ уже выйти в канал —
// из потерянного ответа Telegram не узнать. Авто-переотправка рискует ДУБЛЕМ, поэтому НЕ
// публикуем молча: помечаем 'failed' с честной ошибкой (виден в календаре с кнопкой «Отправить
// снова») и зовём владельца проверить. Так нет ни тихой потери, ни тихого дубля (ревью регрессии).
async function reclaimStuckPosts() {
  const rows = (
    await pool.query(
      `update posts set status = 'failed',
              last_error = 'Публикация прервана перезапуском сервера — проверь канал и при необходимости отправь снова'
        where status = 'publishing' returning id`,
    )
  ).rows;
  if (rows.length) {
    console.log(`[worker] прерванных постов помечено на проверку: ${rows.length}`);
    await notifyOwner(
      `⚠️ Прервалась публикация ${rows.length} поста(ов) при перезапуске сервера. Проверь, вышли ли они в канал; если нет — открой пост и нажми «Отправить снова».`,
    );
  }
}

// Graceful shutdown: при деплое (SIGTERM) даём текущей задаче доработать, чтобы не оставлять
// пост в 'publishing'.
async function shutdown(sig) {
  console.log(`[worker] ${sig} — завершаюсь аккуратно…`);
  try {
    await worker?.close();
    await mediaWorker?.close();
    await statsWorker?.close();
    await cronWorker?.close();
    await cronQueue?.close();
  } catch {
    /* всё равно выходим */
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Регистрация плановых задач (идемпотентно: upsert не плодит дубли при повторном запуске).
// Расписание живёт в Redis и стреляет независимо от того, когда стартовал процесс.
for (const s of AUTOPILOT_ONLY || MEDIA_ONLY ? [] : CRON_SCHEDULES) {
  await cronQueue.upsertJobScheduler(s.name, { pattern: s.pattern, tz: "Europe/Moscow" }, { name: s.name });
}
if (!AUTOPILOT_ONLY && !MEDIA_ONLY) {
  console.log("[cron] планировщики зарегистрированы:", CRON_SCHEDULES.map((s) => s.name).join(", "));
}

// Стартовая свежесть: разовые задачи сразу после запуска, чтобы не ждать первого тика.
// Идут через ту же очередь (concurrency: 1) — не долбят t.me все разом при старте.
// weekly НЕ запускаем: планы не должны перестраиваться при каждом рестарте (лечит баг «плана нет»).
for (const name of AUTOPILOT_ONLY || MEDIA_ONLY ? [] : ["stats", "recon", "trend", "discover"]) {
  await cronQueue.add(name, {}, { jobId: `startup-${name}`, removeOnComplete: true }).catch(() => {});
}

// Восстановление постов, застрявших в 'publishing' (разовая проверка при старте, не цикл).
if (!AUTOPILOT_ONLY && !MEDIA_ONLY) {
  reclaimStuckPosts().catch((e) => console.error("[worker] восстановление постов:", e));
}

// Приём команд и кнопок. Бесконечный цикл — не ждём его, он живёт сам по себе.
if (!AUTOPILOT_ONLY && !MEDIA_ONLY) pollUpdates().catch((e) => console.error("[bot] поллинг умер:", e));

console.log(
  MEDIA_ONLY
    ? "[worker] запущен media-only режим (без публикации, аналитики, крона и бота)"
    : AUTOPILOT_ONLY
      ? "[worker] запущен безопасный режим автопилота (без публикации, крона и бота)"
      : "[worker] запущен: публикация, крон-планировщики и бот слушаются…",
);
