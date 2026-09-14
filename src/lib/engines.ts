// Каталог движков ИИ (ТЗ Д.8). Один список — и для пикера в студии, и для сервера.
//
// Переходник ai-provider.ts маршрутизирует запрос строго по этому id: Ollama, OpenAI,
// нативный Anthropic или OpenAI-совместимый Gemini. Нереализованные адаптеры остаются
// видны как roadmap, но выбрать их нельзя.
//
// Пользователь выбирает вариант Авроры. Технические маршруты и резервирование
// остаются внутри сервиса; ID — долговечные слоты и сохраняются для совместимости
// уже записанных пользовательских и Autopilot-настроек при смене provider model.
import { ENGINE_PRESENTATION } from "./engine-presentation.mjs";

export type EngineId =
  | "navy-deepseek-pro"
  | "navy-deepseek-flash"
  | "navy-gpt-5-4"
  | "navy-qwen-3-6"
  | "navy-minimax-m3"
  | "local"
  | "openai"
  | "claude"
  | "gemini"
  | "yandex"
  | "gigachat";

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
  /** Реально реализованный протокол. null = витрина roadmap, выбрать нельзя. */
  protocol: "ollama" | "openai" | "anthropic" | null;
  /** Переменная окружения с ключом. null у локального/неподдерживаемого движка. */
  keyEnv: string | null;
  /** Доступен ли из России без прокси — важнее, чем кажется (ТЗ: продукт российский). */
  ruFriendly: boolean;
  /** Главный вариант в продуктовом сценарии, а не просто первый пункт списка. */
  recommended?: boolean;
}

const ENGINE_CONFIGS: Engine[] = [
  {
    id: "navy-deepseek-pro",
    label: "GLM-5.3",
    vendor: "NavyAI",
    note: "Глубокая проработка сложных и длинных материалов.",
    needs: "NAVYAI_API_KEY",
    baseUrl: "https://api.navy/v1",
    model: "glm-5.3",
    protocol: "openai",
    keyEnv: "NAVYAI_API_KEY",
    ruFriendly: false,
  },
  {
    id: "navy-deepseek-flash",
    label: "Qwen 3.8 27B",
    vendor: "NavyAI",
    note: "Быстрые повседневные посты и новые варианты подачи.",
    needs: "NAVYAI_API_KEY",
    baseUrl: "https://api.navy/v1",
    model: "qwen3.8-27b",
    protocol: "openai",
    keyEnv: "NAVYAI_API_KEY",
    ruFriendly: false,
    recommended: true,
  },
  {
    id: "navy-gpt-5-4",
    label: "GPT-5.6 Terra",
    vendor: "NavyAI",
    note: "Универсальный редактор для структуры и аккуратной переработки текста.",
    needs: "NAVYAI_API_KEY",
    baseUrl: "https://api.navy/v1",
    model: "gpt-5.6-terra",
    protocol: "openai",
    keyEnv: "NAVYAI_API_KEY",
    ruFriendly: false,
  },
  {
    id: "navy-qwen-3-6",
    label: "Qwen 3.6 27B",
    vendor: "NavyAI",
    note: "Экономный вариант для коротких постов, опросов и быстрых черновиков.",
    needs: "NAVYAI_API_KEY",
    baseUrl: "https://api.navy/v1",
    model: "qwen3.6-27b",
    protocol: "openai",
    keyEnv: "NAVYAI_API_KEY",
    ruFriendly: false,
  },
  {
    id: "navy-minimax-m3",
    label: "DeepSeek V4 Flash",
    vendor: "NavyAI",
    note: "Свежая подача, альтернативные углы и быстрые варианты текста.",
    needs: "NAVYAI_API_KEY",
    baseUrl: "https://api.navy/v1",
    model: "deepseek-v4-flash",
    protocol: "openai",
    keyEnv: "NAVYAI_API_KEY",
    ruFriendly: false,
  },
  {
    id: "local",
    label: "Hermes 3",
    vendor: "Локально",
    note: "Крутится на твоей машине. Бесплатно и без интернета, но русский средний и медленно.",
    needs: null,
    baseUrl: null,
    model: "hermes3",
    protocol: "ollama",
    keyEnv: null,
    ruFriendly: true,
  },
  {
    id: "openai",
    label: "GPT-4o mini",
    vendor: "OpenAI",
    note: "Отличный русский, копейки за пост. Из России нужен прокси и зарубежная карта.",
    needs: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    protocol: "openai",
    keyEnv: "OPENAI_API_KEY",
    ruFriendly: false,
  },
  {
    id: "claude",
    label: "Claude Haiku",
    vendor: "Anthropic",
    note: "Сильный русский и длинный контекст. Тоже нужен прокси и зарубежная оплата.",
    needs: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-haiku-4-5-20251001",
    protocol: "anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    ruFriendly: false,
  },
  {
    id: "gemini",
    label: "Gemini Flash",
    vendor: "Google",
    note: "Быстрый и дешёвый. Есть щедрый бесплатный лимит, но из России без прокси не ходит.",
    needs: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.5-flash",
    protocol: "openai",
    keyEnv: "GEMINI_API_KEY",
    ruFriendly: false,
  },
  {
    id: "yandex",
    label: "YandexGPT",
    vendor: "Яндекс",
    note: "Родной русский, платится рублями с российской карты. Прокси не нужен.",
    needs: "адаптер Yandex AI Studio",
    baseUrl: null,
    model: "yandexgpt-lite",
    protocol: null,
    keyEnv: null,
    ruFriendly: true,
  },
  {
    id: "gigachat",
    label: "GigaChat",
    vendor: "Сбер",
    note: "Тоже рубли и российская карта. Протокол свой — понадобится переходник.",
    needs: "OAuth-адаптер GigaChat",
    baseUrl: null,
    model: "GigaChat",
    protocol: null,
    keyEnv: null,
    ruFriendly: true,
  },
];

export const ENGINES: Engine[] = ENGINE_CONFIGS.map((engine) => ({
  ...engine,
  ...ENGINE_PRESENTATION[engine.id],
}));

export const DEFAULT_ENGINE: EngineId = "local";

export function getEngine(id: string | null | undefined): Engine {
  return ENGINES.find((e) => e.id === id) ?? ENGINES.find((e) => e.id === DEFAULT_ENGINE)!;
}

export function isEngineId(v: unknown): v is EngineId {
  return typeof v === "string" && ENGINES.some((e) => e.id === v);
}
