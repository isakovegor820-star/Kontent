// Д.3 — воркер публикации. Отдельный «всегда включённый» процесс: слушает очередь
// и публикует посты точно в срок с сервера. Пользователь может закрыть ноутбук —
// задача всё равно сработает.
//
// Запуск:  npm run worker   (== node --env-file=.env.local worker.mjs)
// На деплое переезжает на Railway/Render/свой сервер (Vercel для него не подходит).

import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const DATABASE_URL = process.env.DATABASE_URL;
const TOKEN = process.env.TG_BOT_TOKEN;
const OWNER_CHAT = process.env.TG_CHAT_ID;

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

// Куски базы знаний — это НЕ «нарезка стены текста по N знаков». Материал юриста сам
// состоит из готовых единиц: один кейс, один вопрос с ответом, одна услуга, один факт.
// Пустая строка между ними — авторская граница мысли, и она надёжнее любой эвристики.
//
// Абзацы НЕ склеиваем, даже если влезают в один кусок. Замерено на трёх фактах в одном
// источнике (срок процедуры / единственное жильё / МФЦ): склеенный кусок даёт вектор-смесь
// трёх тем, и запрос «заберут ли единственную квартиру?» набрал по нему 0.426 — НИЖЕ порога
// опоры. То есть факт в базе есть, а система ответила бы «не пишу». По абзацам — 0.519,
// проходит. Один кусок = одна мысль.
const CHUNK_MAX = 900; // знаков; выше — в куске неизбежно несколько тем, вектор мутнеет
const CHUNK_MIN = 80; // ниже — обрывок без смысла, липнет к предыдущему куску

function splitChunks(raw) {
  const text = String(raw || "").replace(/\r/g, "").trim();
  if (!text) return [];
  const paras = text
    .split(/\n\s*\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const out = [];
  const push = (t) => {
    const v = t.trim();
    if (!v) return;
    // Короткий хвост сам по себе бесполезен («Исключение:» без продолжения), но и терять
    // его нельзя — приклеиваем к предыдущему куску.
    if (v.length < CHUNK_MIN && out.length) out[out.length - 1] += "\n\n" + v;
    else out.push(v);
  };

  for (const para of paras) {
    if (para.length <= CHUNK_MAX) {
      push(para);
      continue;
    }
    // Абзац длиннее предела — режем по концам предложений, а не по счётчику знаков:
    // обрыв на середине фразы даёт кусок, по которому нельзя написать пост.
    let cur = "";
    for (const sent of para.split(/(?<=[.!?…])\s+/)) {
      if (cur && (cur + " " + sent).length > CHUNK_MAX) {
        push(cur);
        cur = sent;
      } else cur += (cur ? " " : "") + sent;
    }
    push(cur);
  }
  return out;
}

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
  friendly: { p: "Настроение — дружелюбное и тёплое: пиши как хорошему знакомому, просто и по-доброму.", t: 0.7 },
  cheerful: { p: "Настроение — радостное и энергичное: восклицания, лёгкие уместные эмодзи, позитив. Заряжай хорошим настроением.", t: 0.85 },
  expert: { p: "Настроение — экспертное: уверенно, по делу, с конкретикой и пользой, без воды и лишних эмоций.", t: 0.5 },
  bold: { p: "Настроение — дерзкое и уверенное: с характером, цепляй с первой фразы, не бойся острых формулировок (но без грубости).", t: 0.85 },
  inspiring: { p: "Настроение — вдохновляющее: мотивируй, показывай возможности, мягко зови к действию.", t: 0.8 },
  ironic: { p: "Настроение — ироничное: лёгкий юмор и самоирония, подмечай смешное, но по-доброму, без сарказма в адрес читателя.", t: 0.85 },
  calm: { p: "Настроение — спокойное и размеренное: без надрыва и восклицаний, ровный уверенный тон.", t: 0.5 },
};
const DEFAULT_MOOD_W = "friendly";
const moodPromptW = (k) => (MOODS_W[k] || MOODS_W[DEFAULT_MOOD_W]).p;
const moodTempW = (k) => (MOODS_W[k] || MOODS_W[DEFAULT_MOOD_W]).t;
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
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});
// Облачный Postgres рвёт простаивающие соединения. Без этого слушателя обрыв idle-клиента
// = uncaught exception = падение всего воркера. Логируем — пул переподключится сам (ревью).
pool.on("error", (err) =>
  console.error("[worker] простаивающий pg-клиент отвалился (пул переподключится):", err?.message || err),
);

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue("publish", { connection }); // для повторных задач

// Задержки между попытками. По умолчанию 1 / 5 / 15 минут (ТЗ 5.3).
// Для локального теста можно ускорить: RETRY_DELAYS_MS=4000,8000,12000
const RETRY_DELAYS_MS = (process.env.RETRY_DELAYS_MS || "60000,300000,900000")
  .split(",")
  .map(Number);
const MAX_ATTEMPTS = 3;

// Наша разметка → HTML Telegram: ||спойлер|| и **жирный**. Спецсимволы экранируем.
function toTelegramHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|\|([\s\S]+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>")
    .replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>");
}

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

/** buttons — массив рядов: [[{ text, data }|{ text, url }]]. */
function keyboard(buttons) {
  if (!buttons?.length) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })),
    ),
  };
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Честная доставка (надёжность из ТЗ): возвращаем true ТОЛЬКО если Telegram реально
// принял сообщение (ok:true). При сбое сети или ok:false — повторяем несколько раз с
// паузой; если так и не ушло — честно логируем ошибку и возвращаем false.
// Никогда не бросаем: уведомление не должно ронять обработку задачи.
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

const worker = new Worker(
  "publish",
  async (job) => {
    const postId = job.data.postId;

    // Заявляем пост атомарно: публикуем ТОЛЬКО если он ещё scheduled.
    // Так пост никогда не выйдет дважды — даже если задача продублировалась.
    const claim = await pool.query(
      `update posts set status = 'publishing'
       where id = $1 and status = 'scheduled'
       returning id, user_id, channel_id, text, attempts`,
      [postId],
    );
    if (claim.rowCount === 0) {
      console.log(`[worker] пост ${postId} уже обработан или не ждёт публикации — пропускаю`);
      return;
    }
    const post = claim.rows[0];

    const ch = await pool.query(`select tg_chat_id, title, handle from channels where id = $1`, [
      post.channel_id,
    ]);
    const chat = ch.rows[0];
    if (!chat?.tg_chat_id) {
      await pool.query(`update posts set status = 'failed', last_error = $2 where id = $1`, [
        postId,
        "канал не подключён",
      ]);
      return;
    }

    let res;
    try {
      res = await tgSend(chat.tg_chat_id, post.text);
    } catch (err) {
      res = { ok: false, description: String(err?.message || err) };
    }

    // --- Успех ---
    if (res.ok) {
      await pool.query(
        `update posts set status = 'published', tg_message_id = $2, published_at = now(),
                          attempts = attempts + 1, last_error = null
         where id = $1`,
        [postId, res.result.message_id],
      );
      console.log(`[worker] ✅ пост ${postId} вышел (message_id ${res.result.message_id})`);
      const okText =
        `✅ Пост вышел${chat.title ? ` в «${chat.title}»` : ""}. Посмотрим, как зайдёт — цифры пришлю позже.`;
      // Ссылка только у публичного канала: у приватного t.me/<handle>/<id> ведёт в никуда.
      const okBtns = chat.handle
        ? [[{ text: "Открыть пост", url: `https://t.me/${chat.handle}/${res.result.message_id}` }]]
        : undefined;
      if (!(await notifyUser(post.user_id, okText, okBtns))) await notifyOwner(okText);
      return;
    }

    // --- Сбой: до 3 автоповторов ---
    const attempts = post.attempts + 1;
    const reason = res.description || "Telegram не ответил";

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
      // Сообщаем владельцу только после ПЕРВОГО сбоя — тоном из ТЗ 7.5.
      if (attempts === 1) {
        const nextMin = Math.max(1, Math.round((RETRY_DELAYS_MS[1] ?? 300000) / 60000));
        await notifyOwner(
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
      const sent = await notifyUser(post.user_id, failText, failBtn);
      if (!sent) await notifyOwner(failText);
    }
  },
  { connection },
);

worker.on("ready", () => console.log("[worker] очередь публикации слушается"));
worker.on("error", (err) => console.error("[worker] ошибка:", err));
worker.on("failed", (job, err) =>
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

const BOT_POLL = !process.env.TG_WEBHOOK_URL;

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

// "1.2K"/"50" → число
function parseCount(s) {
  const t = String(s).trim().replace(/\s/g, "").replace(",", ".");
  const m = t.match(/^([\d.]+)([KMkm]?)$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (/k/i.test(m[2])) n *= 1000;
  if (/m/i.test(m[2])) n *= 1e6;
  return Math.round(n);
}

// Сумма реакций поста из блока его разметки. Число стоит ПОСЛЕ вложенного эмодзи:
//   <span class="tgme_reaction"><tg-emoji …></tg-emoji>30.7K</span>
// Поэтому берём span целиком, срезаем теги и читаем хвост. Старый вариант ловил текст сразу
// после `tgme_reaction">` и упирался в первый же `<`, то есть всегда возвращал 0 (ревью).
// null — реакции на канале выключены; 0 — реакции есть, но никто не поставил.
function sumReactions(block) {
  const spans = [...block.matchAll(/<span class="tgme_reaction[^"]*">([\s\S]*?)<\/span>/g)];
  if (!spans.length) return null;
  let sum = 0;
  for (const s of spans) {
    const plain = s[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const num = (plain.match(/([\d.,]+[KM]?)\s*$/i) || [])[1];
    if (num) sum += parseCount(num) || 0;
  }
  return sum;
}

async function tgMemberCount(chatId) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getChatMemberCount?chat_id=${chatId}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const d = await r.json();
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
    const r = await fetch(`https://t.me/s/${h}`, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
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

  for (const ch of chans) {
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
  }
  console.log(`[stats] снимок собран за ${today} (каналов: ${chans.length})`);
}

// Недельный отчёт одной страницей — в бот владельцу (ТЗ 5.7, Приложение В).
async function buildWeeklyReport() {
  const week = (
    await pool.query(
      `select count(*)::int as posts,
              coalesce(sum(ps.views), 0)::int as views,
              coalesce(round(avg(ps.views)), 0)::int as avg_views
       from posts p
       join lateral (
         select views from post_stats where post_id = p.id order by snapshot_date desc limit 1
       ) ps on true
       where p.status = 'published' and p.published_at > now() - interval '7 days'`,
    )
  ).rows[0];

  const best = (
    await pool.query(
      `select p.text, ps.views from posts p
       join lateral (select views from post_stats where post_id = p.id order by snapshot_date desc limit 1) ps on true
       where p.status = 'published' and ps.views is not null
       order by ps.views desc limit 1`,
    )
  ).rows[0];

  const growth = (
    await pool.query(
      `select coalesce(sum(subscribers_delta), 0)::int as g
       from channel_stats where snapshot_date > (current_date - 7)`,
    )
  ).rows[0];

  if (!week || week.posts === 0) {
    return `📊 Твоя неделя: постов пока не было. Как выйдет первый — пришлю цифры и совет.`;
  }
  const vw = (n) => plural(n, "просмотр", "просмотра", "просмотров");
  const lines = [
    `📊 Твоя неделя: ${week.posts} ${plural(week.posts, "пост", "поста", "постов")}, ` +
      `суммарно ${week.views} ${vw(week.views)} (в среднем ${week.avg_views} ${vw(week.avg_views)} на пост).`,
  ];
  if (Number(growth.g) !== 0) {
    lines.push(`Подписчиков за неделю: ${growth.g > 0 ? "+" : ""}${growth.g}.`);
  }
  if (best) {
    const snippet = best.text.replace(/\s+/g, " ").slice(0, 60);
    lines.push(`Лучший пост — «${snippet}…» (${best.views} ${vw(best.views)}).`);
    lines.push(`Совет: повтори этот формат — у тебя он заходит лучше остальных.`);
  }
  return lines.join("\n");
}

function plural(n, one, few, many) {
  const m10 = n % 10,
    m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

// ============================================================================
// Д.6 — разведка конкурентов. ТОЛЬКО открытые данные публичного канала:
// getChat (название) + getChatMemberCount (подписчики) + t.me/s/ (посты).
// Закрытых данных не собираем. Тот же всегда-включённый воркер.
// ============================================================================

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return "";
      }
    });
}

// Разбор публичной страницы канала: посты (id, текст, время, просмотры, реакции)
// + запасные название/подписчики из шапки.
async function fetchCompetitorPage(handle) {
  const h = String(handle).replace(/^@/, "");
  const out = { ok: false, title: null, subscribers: null, posts: [] };
  try {
    const r = await fetch(`https://t.me/s/${h}`, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
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
    const gc = await (
      await fetch(`https://api.telegram.org/bot${TOKEN}/getChat?chat_id=${ref}`, {
        signal: AbortSignal.timeout(15_000),
      })
    ).json();
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
async function askAI(system, user, numPredict = 500, mood = null) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const temp = moodTempW(mood);
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
      if (!(await notifyUser(comp.user_id, hitText, hitBtns))) await notifyOwner(hitText);
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
  for (const c of rows) {
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
  }
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
  for (const u of users) {
    try {
      await discoverForUser(u.id);
    } catch (err) {
      console.error(`[поиск] user ${u.id} упал:`, err?.message);
    }
  }
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
  for (const s of rows) {
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
  }
  if (rows.length) console.log(`[насмотренность] цикл: обработано ${rows.length}`);
}

// ============================================================================
// Д.9 — автопилот. Дирижёр: ИИ собирает план недели с опорой на аналитику (Д.5) и
// залёты (Д.7), в стиле пользователя. Пользователь одобряет → посты в очередь (Д.3).
// ============================================================================

// Бриф контента (Д.9). Компактная копия src/lib/brief.ts — воркер отдельный процесс
// и TS не импортирует (та же схема, что с настроениями MOODS_W).
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
      `select niche, audience, rubrics, goal, cta, taboo, ready
         from content_brief where user_id = $1 and channel_id = $2`,
      [userId, channelId],
    )
  ).rows[0];
  if (!b || !b.ready) return null;
  const niche = String(b.niche || "").trim();
  const audience = String(b.audience || "").trim();
  if (niche.length < 3 || audience.length < 3) return null;
  return { ...b, niche, audience, rubrics: b.rubrics || [] };
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

function postSystem(samples, brief, support = []) {
  let s =
    "Ты — редактор Telegram-канала. Пиши живым грамотным русским, обращайся к читателю на «ты», коротко, без приветствий и подписей. Выдай ТОЛЬКО текст поста.";
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

// Ссылки [1] нужны нам, а не читателю: в готовом посте их быть не должно.
const stripCites = (t) => String(t || "").replace(/\s*\[\d+\]/g, "").replace(/[ \t]{2,}/g, " ").trim();

/**
 * Доля утверждений с опорой: сколько предложений помечены ссылкой на факт.
 * Мера грубая, но честная и проверяемая — ловит ровно то, что нужно: пост, где модель
 * ушла от фактов в свободный пересказ. Короткие фразы («Да.», заголовок) не считаем.
 */
function citedShare(text) {
  const sents = String(text || "")
    .split(/(?<=[.!?…])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 25);
  if (!sents.length) return 0;
  return sents.filter((x) => /\[\d+\]/.test(x)).length / sents.length;
}

/**
 * Конкретные темы недели. Раньше здесь были заглушки вида «Полезный совет по твоей
 * теме» — их и уносило в ИИ как тему, поэтому посты выходили ни о чём. Теперь темы
 * придумывает ИИ ПОД НИШУ из брифа; залёты конкурентов (Д.7) идут первыми.
 * Возвращает [{ topic, rubric }]. Пусто = движок молчит, врать не будем.
 */
async function planTopics(brief, need, hitTopics, mood) {
  const out = hitTopics.slice(0, need).map((t) => ({ topic: t, rubric: null }));
  if (out.length >= need) return out;

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
    "— темы не повторяют друг друга.",
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

/**
 * Раскладка N постов по НЕДЕЛЕ (7 дней), а не по N дням.
 * Раньше пост i вставал на день i+1: пять постов — пять дней, семь — семь. Поэтому и стоял
 * потолок 7 — он прятал то, что при 14 план разъезжался на две недели вместо «14 за неделю».
 * Теперь: дни делим поровну, а внутри дня разносим по часам, чтобы посты не падали в одну минуту.
 * Возвращает массив ISO-строк длиной N.
 */
function weekSlots(n, bestHour) {
  const perDay = Math.ceil(n / 7);
  const out = [];
  for (let i = 0; i < n; i++) {
    const day = Math.floor(i / perDay) + 1;
    const slot = i % perDay;
    let hour;
    if (perDay === 1) {
      hour = bestHour; // один пост в день — ставим в лучший час по аналитике
    } else {
      // Несколько постов в день — разносим равномерно по дневному окну 9:00–21:00.
      // Впритык друг к другу их ставить нельзя: подписчик получит пачку уведомлений.
      const from = 9;
      const to = 21;
      hour = Math.round(from + (slot * (to - from)) / (perDay - 1));
    }
    out.push(`${mskDatePlus(day)}T${String(hour).padStart(2, "0")}:00:00+03:00`);
  }
  return out;
}

// МСК-дата через K дней в формате YYYY-MM-DD.
function mskDatePlus(days) {
  return new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "Europe/Moscow",
  });
}

// План собирается ДЛЯ КАНАЛА. Раньше здесь стоял `limit 1` без order by: у кого два канала,
// тот получал посты по брифу одного канала в (случайно выбранный) другой, а второй канал молчал.
async function buildAutopilotPlan(userId, channelId) {
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

  // Темы: сначала залёты Д.7, потом форматные заготовки.
  const ideaTopics = (
    await pool.query(
      `select ci.topic from content_ideas ci
         join competitors c on c.id = ci.competitor_id
        where ci.user_id = $1 and c.channel_id = $2 and ci.status = 'new' and ci.topic is not null
        order by ci.hit_ratio desc nulls last limit $3`,
      [userId, channelId, N],
    )
  ).rows.map((r) => r.topic);
  if (ideaTopics.length)
    rule += ` Взял ${ideaTopics.length} ${plural(ideaTopics.length, "тему", "темы", "тем")} из залётов конкурентов.`;

  // Образцы стиля — только из ЭТОГО канала. Иначе ИИ учится голосу соседнего канала:
  // посты про банкротство начинают звучать как канал про ИИ в праве.
  const samples = (
    await pool.query(
      `select text from posts
        where user_id = $1 and channel_id = $2 and status = 'published' and length(trim(text)) > 0
        order by published_at desc limit 10`,
      [userId, channelId],
    )
  ).rows.map((r) => r.text);

  // Пересборка не должна плодить дубли: снимаем ещё не вышедшие посты прошлого плана (ревью Д.9).
  await cancelPreviousPlan(userId, channelId);

  // Полный режим требует и mode='full', и заслуженный streak (защита в глубину, ревью).
  const full = (st?.mode || "confirm") === "full" && (st?.approvals_streak ?? 0) >= 2;
  const planMood = await userMood(userId); // настроение агента для постов плана
  // Время постов считаем ЗАРАНЕЕ на всю неделю: раскладка зависит от их числа, а не от порядка.
  const slots = weekSlots(N, bestHour);

  // Сначала конкретные темы под нишу, только потом тексты.
  const topics = await planTopics(brief, N, ideaTopics, planMood);
  if (!topics.length) {
    console.log(`[auto] user ${userId}: ИИ не дал тем — план не собрать`);
    return { error: "ai_unavailable" };
  }
  rule += ` Темы — под твою нишу: ${brief.niche}.`;

  const items = [];
  for (let i = 0; i < topics.length; i++) {
    const { topic, rubric } = topics[i];
    const aiDraft = await askAI(
      postSystem(samples, brief) + "\n" + moodPromptW(planMood),
      rubric
        ? `Напиши пост в рубрику «${rubric}» на тему: ${topic}.`
        : `Напиши пост на тему: ${topic}.`,
      350,
      planMood,
    );
    const draft = aiDraft || `Черновик на тему «${topic}» — ИИ допишет, когда движок будет доступен.`;
    let scheduledAt = slots[i];
    const item = { i, scheduledAt, topic, rubric, draft, status: "pending", aiReady: !!aiDraft };
    // Полный режим публикует БЕЗ подтверждения — но ТОЛЬКО настоящий ИИ-текст. Заглушку
    // (ИИ недоступен) в живой канал автоматически не отправляем: оставляем на подтверждение (честность).
    if (full && aiDraft) {
      const t = new Date(scheduledAt).getTime();
      if (t < Date.now() + 60_000) scheduledAt = new Date(Date.now() + 120_000).toISOString();
      item.scheduledAt = scheduledAt;
      item.postId = await enqueuePost(userId, ch.id, draft, scheduledAt);
      item.status = "approved";
    }
    items.push(item);
  }

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
  const planText =
    planStatus === "approved"
      ? `🚀 Автопилот (полный режим)${who}: ${N} ${plural(N, "пост", "поста", "постов")} на неделю уже в очереди.\n${rule}`
      : full && anyPending
        ? `🗓 План собран${who}, но ИИ был недоступен для части постов — их надо подтвердить вручную.`
        : `🗓 План на неделю готов${who}: ${N} ${plural(N, "пост", "поста", "постов")}.\n${rule}`;
  const planBtns =
    planStatus === "pending"
      ? [[{ text: `Одобрить всё (${N})`, data: `plan:approve:${ins.rows[0].id}` }]]
      : undefined;
  if (!(await notifyUser(userId, planText, planBtns))) await notifyOwner(planText);
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
  await queue.add(
    "publish",
    { postId },
    { delay, jobId: `post-${postId}`, removeOnComplete: true, removeOnFail: false },
  );
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

  await pool.query(`update autopilot_plan set items = $2, status = 'approved' where id = $1`, [
    planId,
    JSON.stringify(items),
  ]);
  // Одобрение без правок — заслуга ЭТОГО канала: полный режим открывается на нём, а не разом
  // на всех. То же правило, что и в кабинете (/api/autopilot/approve).
  await pool.query(
    `update autopilot_settings
        set approvals_streak = case when $3 then approvals_streak + 1 else 0 end, updated_at = now()
      where user_id = $1 and channel_id = $2`,
    [userId, plan.channel_id, n > 0],
  );
  const who = ch.title ? ` — «${ch.title}»` : "";
  return `Готово${who} — ${n} ${plural(n, "пост", "поста", "постов")} в очереди.`;
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
const statsWorker = new Worker(
  "stats",
  async (job) => {
    if (job.name === "collect") {
      await collectStats();
    } else if (job.name === "report") {
      const delivered = await notifyOwner(await buildWeeklyReport());
      console.log(
        delivered
          ? "[stats] недельный отчёт отправлен владельцу"
          : "[stats] недельный отчёт НЕ доставлен — см. ошибку выше",
      );
      if (!delivered) throw new Error("недельный отчёт не доставлен"); // пусть очередь повторит
    } else if (job.name === "competitor") {
      // Первичный сбор сразу после добавления — досье готово за секунды, а не за час.
      const c = (
        await pool.query(`select id, user_id, handle, title from competitors where id = $1`, [job.data.id])
      ).rows[0];
      if (c) await collectCompetitor(c);
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
      try {
        const r = await buildAutopilotPlan(userId, channelId);
        if (r?.error) throw new Error(r.error);
      } catch (err) {
        // Только план ЭТОГО канала: у соседнего может честно собираться свой.
        await pool
          .query(
            `update autopilot_plan set status = 'error'
              where user_id = $1 and channel_id = $2 and status = 'building'`,
            [userId, channelId],
          )
          .catch(() => {});
        throw err;
      }
    }
  },
  { connection },
);
statsWorker.on("error", (err) => console.error("[stats] ошибка:", err));

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
    await worker.close();
    await statsWorker.close();
  } catch {
    /* всё равно выходим */
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Собираем статистику при старте и раз в сутки; разведку — при старте и каждые 2 часа;
// недельные планы автопилота — раз в неделю.
reclaimStuckPosts().catch((e) => console.error("[worker] восстановление постов:", e));
collectStats().catch((e) => console.error("[stats] стартовый сбор:", e));
setInterval(() => collectStats().catch((e) => console.error("[stats] суточный сбор:", e)), 86_400_000);
collectCompetitors().catch((e) => console.error("[recon] стартовый сбор:", e));
setInterval(() => collectCompetitors().catch((e) => console.error("[recon] цикл:", e)), 2 * 60 * 60 * 1000);
// Общие источники ниши: тоже при старте и раз в 2 часа. Список один на всю платформу,
// поэтому нагрузка не растёт с числом пользователей.
collectTrendSources().catch((e) => console.error("[насмотренность] стартовый сбор:", e));
setInterval(() => collectTrendSources().catch((e) => console.error("[насмотренность] цикл:", e)), 2 * 60 * 60 * 1000);

// Поиск соседей по нише: при старте и раз в сутки. Реже, чем разведка, — граф меняется
// медленно, а проход стоит десятков запросов к t.me.
discoverAll().catch((e) => console.error("[поиск] стартовый проход:", e));
setInterval(() => discoverAll().catch((e) => console.error("[поиск] суточный проход:", e)), 86_400_000);

// Приём команд и кнопок. Бесконечный цикл — не ждём его, он живёт сам по себе.
pollUpdates().catch((e) => console.error("[bot] поллинг умер:", e));
setInterval(() => weeklyPlans().catch((e) => console.error("[auto] недельные планы:", e)), 7 * 86_400_000);

console.log("[worker] запущен, жду задачи публикации и сбор статистики…");
