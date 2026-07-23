// Ограничение частоты запросов (rate limiting) на Redis.
//
// Зачем: до этого лимитов не было вовсе. /api/auth/login брутфорсился (scrypt замедляет
// перебор, но не останавливает), /api/lead спамился строками в базу в обход honeypot,
// /api/auth/register позволял массово плодить аккаунты. Теперь у каждого чувствительного
// роута есть потолок «N попыток за окно» на IP (и на аккаунт для входа).
//
// Считаем атомарно одним Lua-скриптом (INCR + условный EXPIRE + TTL): без скрипта между
// INCR и EXPIRE есть гонка, и ключ мог бы остаться без срока жизни навсегда.
//
// Redis лёг — НЕ блокируем пользователя (fail-open): лимит вторичен, доступность входа
// важнее. Атака при упавшем Redis всё равно упирается в scrypt и honeypot.

import Redis from "ioredis";
import { NextResponse } from "next/server";

const globalForRedis = globalThis as unknown as { auroraRateRedis?: Redis };

// Один клиент на процесс (как пул базы и очереди). ioredis сам разбирает URL,
// включая rediss:// с логином/паролем — тот же REDIS_URL, что у BullMQ.
function getRedis(): Redis {
  if (globalForRedis.auroraRateRedis) return globalForRedis.auroraRateRedis;
  const url = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const client = new Redis(url, {
    maxRetriesPerRequest: 1, // не копим команды при обрыве — лимит не критичен
    connectTimeout: 3000,
  });
  client.on("error", (err) => console.error("[rate-limit] redis:", err.message));
  globalForRedis.auroraRateRedis = client;
  return client;
}

// Фикс-окно: первый запрос заводит ключ со сроком жизни, остальные только инкрементят.
// Возвращает [счётчик, остаток жизни ключа в секундах].
const WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('TTL', KEYS[1])}
`;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfter: number; // секунд до сброса окна (0, если лимит не исчерпан)
}

/**
 * Проверить лимит `limit` запросов за `windowSeconds` для ключа `key`.
 * Ключ в Redis получается с префиксом rl: — не пересечётся с ключами BullMQ.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  try {
    const [count, ttl] = (await getRedis().eval(
      WINDOW_SCRIPT,
      1,
      `rl:${key}`,
      String(windowSeconds),
    )) as [number, number];

    const allowed = count <= limit;
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - count),
      // TTL бывает -1, если ключ по какой-то причине без срока — страхуемся единицей.
      retryAfter: allowed ? 0 : Math.max(1, ttl),
    };
  } catch (err) {
    // Fail-open: Redis недоступен — пропускаем, но loudly.
    console.error("[rate-limit] не удалось проверить лимит, пропускаю:", err);
    return { allowed: true, limit, remaining: limit, retryAfter: 0 };
  }
}

/** IP клиента. Vercel кладёт цепочку в x-forwarded-for — берём первый (реальный клиент).
 *  Принимаем базовый Request: подходит и NextRequest (вход/регистрация), и Request (lead). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/** Единый ответ 429 — с заголовками, чтобы клиент мог показать «повторите через N сек». */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  return NextResponse.json(
    { ok: false, error: "rate_limited", retryAfter: result.retryAfter },
    {
      status: 429,
      headers: {
        "Retry-After": String(result.retryAfter),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
      },
    },
  );
}
