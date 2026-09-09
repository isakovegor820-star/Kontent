import { resolveAiEngineRuntime } from "../../lib/ai-engine-policy.mjs";
import { MEDIA_MODELS } from "../../lib/media-generation.mjs";

/** Synthetic accounting ONLY for disposable infrastructure and fake providers. Never production pricing. */
export function fakeAiSpendEnv() {
  const tariff = { inputMicrousdPerMillionTokens: 1000, outputMicrousdPerMillionTokens: 1000 };
  const tariffs = {};
  for (const engine of ["navy-deepseek-pro", "navy-deepseek-flash", "navy-gpt-5-4", "navy-qwen-3-6", "navy-minimax-m3", "openai", "claude", "gemini"]) {
    const runtime = resolveAiEngineRuntime(engine, {});
    tariffs[`${runtime.id}/${runtime.model}`] = tariff;
  }
  tariffs["openai-embedding/text-embedding-3-small"] = tariff;
  for (const provider of ["openai-transcription", "navy-transcription"]) {
    for (const model of ["whisper-1", "gpt-4o-mini-transcribe"]) {
      tariffs[`${provider}/${model}`] = { ...tariff, unitMicrousd: 10 };
    }
  }
  for (const catalog of Object.values(MEDIA_MODELS)) {
    for (const model of Object.keys(catalog)) tariffs[`navy-media/${model}`] = { ...tariff, unitMicrousd: 1000 };
  }
  return {
    AI_SPEND_USER_DAILY_MICROUSD: "1000000000",
    AI_SPEND_PROJECT_DAILY_MICROUSD: "2000000000",
    AI_SPEND_GLOBAL_DAILY_MICROUSD: "3000000000",
    AI_SPEND_USER_CONCURRENCY: "30",
    AI_SPEND_PROJECT_CONCURRENCY: "60",
    AI_SPEND_GLOBAL_CONCURRENCY: "120",
    AI_SPEND_TARIFFS_JSON: JSON.stringify(tariffs),
  };
}
