// Единая точка чтения REDIS_URL. Молчаливый фолбэк на localhost допустим только вне
// production: забытая переменная на боевом сервере превращала воркер в «здоровый»
// процесс, который слушает несуществующий локальный Redis (посты молча не выходят).
// В production поведение симметрично БД: нет настройки — процесс не стартует.
// Явно заданный локальный REDIS_URL при этом разрешён: на одном сервере Redis
// законно живёт на 127.0.0.1 — опасен именно молчаливый фолбэк, а не сам адрес.

export const LOCAL_REDIS_URL = "redis://127.0.0.1:6379";

export function resolveRedisUrl(env = process.env) {
  const url = String(env.REDIS_URL || "").trim();
  if (url) return url;
  if (env.NODE_ENV === "production") {
    throw new Error("redis_url_not_configured");
  }
  return LOCAL_REDIS_URL;
}
