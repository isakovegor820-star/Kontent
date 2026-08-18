const DEFAULT_OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1";
const DEFAULT_NAVY_TRANSCRIPTION_URL = "https://api.navy/v1";

function baseUrl(value, fallback) {
  return String(value || fallback).trim().replace(/\/+$/u, "");
}

/** Resolve one OpenAI-compatible speech-to-text provider without exposing its key. */
export function resolveTranscriptionRuntime(env = process.env) {
  const openAiKey = String(env.OPENAI_API_KEY || env.AI_API_KEY || "").trim();
  if (openAiKey) {
    return {
      provider: "openai",
      apiKey: openAiKey,
      baseUrl: baseUrl(env.OPENAI_API_URL || env.AI_API_URL, DEFAULT_OPENAI_TRANSCRIPTION_URL),
      model: String(env.OPENAI_TRANSCRIPTION_MODEL || "whisper-1").trim() || "whisper-1",
    };
  }

  const navyKey = String(env.NAVYAI_API_KEY || "").trim();
  if (navyKey) {
    return {
      provider: "navy",
      apiKey: navyKey,
      baseUrl: baseUrl(env.NAVYAI_API_URL, DEFAULT_NAVY_TRANSCRIPTION_URL),
      model: String(env.NAVYAI_TRANSCRIPTION_MODEL || "whisper-1").trim() || "whisper-1",
    };
  }

  return null;
}
