const ENGINES = Object.freeze({
  "navy-deepseek-pro": { label: "DeepSeek V4 Pro", protocol: "openai", model: "deepseek-v4-pro", baseUrl: "https://api.navy/v1", key: "NAVYAI_API_KEY" },
  "navy-deepseek-flash": { label: "DeepSeek V4 Flash", protocol: "openai", model: "deepseek-v4-flash", baseUrl: "https://api.navy/v1", key: "NAVYAI_API_KEY" },
  "navy-gpt-5-4": { label: "GPT-5.4", protocol: "openai", model: "gpt-5.4", baseUrl: "https://api.navy/v1", key: "NAVYAI_API_KEY" },
  "navy-qwen-3-6": { label: "Qwen 3.6 27B", protocol: "openai", model: "qwen3.6-27b", baseUrl: "https://api.navy/v1", key: "NAVYAI_API_KEY" },
  "navy-minimax-m3": { label: "MiniMax M3", protocol: "openai", model: "minimax-m3", baseUrl: "https://api.navy/v1", key: "NAVYAI_API_KEY" },
  local: { label: "Hermes 3", protocol: "ollama", model: "hermes3", baseUrl: "http://127.0.0.1:11434", key: null },
  openai: { label: "GPT-4o mini", protocol: "openai", model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", key: "OPENAI_API_KEY" },
  claude: { label: "Claude Haiku", protocol: "anthropic", model: "claude-haiku-4-5-20251001", baseUrl: "https://api.anthropic.com/v1", key: "ANTHROPIC_API_KEY" },
  gemini: { label: "Gemini Flash", protocol: "openai", model: "gemini-3.5-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", key: "GEMINI_API_KEY" },
  yandex: { label: "YandexGPT", protocol: null, model: "yandexgpt-lite", baseUrl: "", key: null },
  gigachat: { label: "GigaChat", protocol: null, model: "GigaChat", baseUrl: "", key: null },
});

export function isConfiguredEngineId(value) {
  return typeof value === "string" && Object.hasOwn(ENGINES, value);
}

const trimUrl = (value) => String(value || "").replace(/\/+$/u, "");

export function resolveAiEngineRuntime(engineId, env = process.env) {
  const id = isConfiguredEngineId(engineId) ? engineId : "local";
  const definition = ENGINES[id];
  if (!definition.protocol) {
    return {
      id,
      label: definition.label,
      protocol: null,
      baseUrl: "",
      model: definition.model,
      key: "",
      keyEnv: null,
      supported: false,
      configured: false,
    };
  }
  if (id === "local") {
    return {
      id,
      label: definition.label,
      protocol: "ollama",
      baseUrl: trimUrl(env.OLLAMA_URL || definition.baseUrl),
      model: env.AI_MODEL || definition.model,
      key: "",
      keyEnv: null,
      supported: true,
      configured: true,
    };
  }
  let key = definition.key ? env[definition.key] || "" : "";
  let baseUrl = definition.baseUrl;
  let model = definition.model;
  if (id.startsWith("navy-")) baseUrl = env.NAVYAI_API_URL || baseUrl;
  if (id === "openai") {
    key = env.OPENAI_API_KEY || env.AI_API_KEY || "";
    baseUrl = env.OPENAI_API_URL || env.AI_API_URL || baseUrl;
    model = env.OPENAI_MODEL || env.AI_CLOUD_MODEL || model;
  }
  if (id === "claude") {
    baseUrl = env.ANTHROPIC_API_URL || baseUrl;
    model = env.ANTHROPIC_MODEL || model;
  }
  if (id === "gemini") {
    baseUrl = env.GEMINI_API_URL || baseUrl;
    model = env.GEMINI_MODEL || model;
  }
  return {
    id,
    label: definition.label,
    protocol: definition.protocol,
    baseUrl: trimUrl(baseUrl),
    model,
    key,
    keyEnv: definition.key,
    supported: true,
    configured: Boolean(key),
  };
}

/** One policy for background/direct surfaces when no explicit account choice exists. */
export function configuredServiceEngine(requested = null, env = process.env) {
  if (isConfiguredEngineId(requested)) return requested;
  if (isConfiguredEngineId(env.AI_SERVICE_ENGINE)) return env.AI_SERVICE_ENGINE;
  if (env.NAVYAI_API_KEY) return "navy-gpt-5-4";
  if (env.OPENAI_API_KEY || env.AI_API_KEY) return "openai";
  if (env.ANTHROPIC_API_KEY) return "claude";
  if (env.GEMINI_API_KEY) return "gemini";
  return "local";
}

export function configuredAiFallbacks(primary, env = process.env) {
  if (primary === "local") return [];
  const explicit = String(env.AI_FALLBACK_ENGINES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(isConfiguredEngineId);
  // `/models` only proves that a model is present in the provider catalogue. A concrete
  // `/chat/completions` call can still fail for one routed upstream while another model on
  // the same NavyAI endpoint/key is healthy. Keep the whole same-credential fleet available
  // as an automatic safety net; this neither changes data residency nor sends the prompt to
  // another vendor. Explicit operator fallbacks are attempted first because they encode the
  // latest observed provider health; the remaining same-provider fleet is the final tier.
  const sameProvider = primary.startsWith("navy-")
    ? [
        "navy-gpt-5-4",
        "navy-minimax-m3",
        "navy-deepseek-flash",
        "navy-qwen-3-6",
        "navy-deepseek-pro",
      ]
    : [];
  const candidates = env.AI_FALLBACK_STRICT === "1"
    ? explicit
    : [...explicit, ...sameProvider];
  return [...new Set(candidates)]
    .filter((id) => id !== primary)
    .filter((id) => {
      const runtime = resolveAiEngineRuntime(id, env);
      return runtime.supported && runtime.configured;
    });
}

/**
 * Heavy background generations may run concurrently when their primary provider is cloud.
 * Local Ollama calls are serialized by ai-completion-service itself, including calls reached
 * through a fallback. Treating a last-resort local fallback as the whole plan's concurrency
 * policy made healthy cloud plans generate every post one by one.
 */
export function configuredAiConcurrency(primary, env = process.env, cloudConcurrency = 3) {
  const requested = isConfiguredEngineId(primary) ? primary : configuredServiceEngine(null, env);
  return resolveAiEngineRuntime(requested, env).protocol === "ollama"
    ? 1
    : Math.max(1, Math.round(Number(cloudConcurrency) || 1));
}
