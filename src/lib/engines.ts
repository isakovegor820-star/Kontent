// Каталог движков ИИ (ТЗ Д.8). Один список — и для пикера в студии, и для сервера.
//
// ЗАЧЕМ ЭТО ТАК: переходник ai-provider.ts уже умеет два движка — локальный Ollama и любой
// OpenAI-совместимый по AI_API_KEY. Пикер не «фейковый выбор», а витрина этого механизма:
// показывает, что подключено СЕЙЧАС, а что ждёт ключа, и честно говорит, какого именно.
// Выбор пользователя сохраняется всегда — подключишь ключ, и он заработает без правок кода.
//
// ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ: молчаливой подмены. Если человек выбрал Claude, а ключа нет,
// мы НЕ пишем тайком локальным Hermes и не делаем вид, что это Claude. Скажем прямо.

export type EngineId = "local" | "openai" | "claude" | "gemini" | "yandex" | "gigachat";

export interface Engine {
  id: EngineId;
  label: string;
  vendor: string;
  /** Чем хорош — человеческим языком, без маркетинга. */
  note: string;
  /** Что нужно, чтобы включить. null — ничего, работает как есть. */
  needs: string | null;
  /** Базовый URL OpenAI-совместимого API. null — у движка свой протокол (нужен адаптер). */
  baseUrl: string | null;
  /** Имя модели для запроса. */
  model: string;
  /** Доступен ли из России без прокси — важнее, чем кажется (ТЗ: продукт российский). */
  ruFriendly: boolean;
}

export const ENGINES: Engine[] = [
  {
    id: "local",
    label: "Hermes 3",
    vendor: "Локально",
    note: "Крутится на твоей машине. Бесплатно и без интернета, но русский средний и медленно.",
    needs: null,
    baseUrl: null,
    model: "hermes3",
    ruFriendly: true,
  },
  {
    id: "openai",
    label: "GPT-4o mini",
    vendor: "OpenAI",
    note: "Отличный русский, копейки за пост. Из России нужен прокси и зарубежная карта.",
    needs: "AI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    ruFriendly: false,
  },
  {
    id: "claude",
    label: "Claude Haiku",
    vendor: "Anthropic",
    note: "Сильный русский и длинный контекст. Тоже нужен прокси и зарубежная оплата.",
    needs: "AI_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-haiku-4-5-20251001",
    ruFriendly: false,
  },
  {
    id: "gemini",
    label: "Gemini Flash",
    vendor: "Google",
    note: "Быстрый и дешёвый. Есть щедрый бесплатный лимит, но из России без прокси не ходит.",
    needs: "AI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.0-flash",
    ruFriendly: false,
  },
  {
    id: "yandex",
    label: "YandexGPT",
    vendor: "Яндекс",
    note: "Родной русский, платится рублями с российской карты. Прокси не нужен.",
    needs: "AI_API_KEY",
    baseUrl: "https://llm.api.cloud.yandex.net/v1",
    model: "yandexgpt-lite",
    ruFriendly: true,
  },
  {
    id: "gigachat",
    label: "GigaChat",
    vendor: "Сбер",
    note: "Тоже рубли и российская карта. Протокол свой — понадобится переходник.",
    needs: "AI_API_KEY",
    baseUrl: null,
    model: "GigaChat",
    ruFriendly: true,
  },
];

export const DEFAULT_ENGINE: EngineId = "local";

export function getEngine(id: string | null | undefined): Engine {
  return ENGINES.find((e) => e.id === id) ?? ENGINES.find((e) => e.id === DEFAULT_ENGINE)!;
}

export function isEngineId(v: unknown): v is EngineId {
  return typeof v === "string" && ENGINES.some((e) => e.id === v);
}
