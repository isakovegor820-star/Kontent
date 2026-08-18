import { describe, expect, it } from "vitest";

import { resolveTranscriptionRuntime } from "./transcription-runtime.mjs";

describe("transcription runtime", () => {
  it("prefers an explicitly configured OpenAI-compatible transcription service", () => {
    expect(resolveTranscriptionRuntime({
      OPENAI_API_KEY: "openai-secret",
      OPENAI_API_URL: "https://speech.example/v1/",
      OPENAI_TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
      NAVYAI_API_KEY: "navy-secret",
    })).toEqual({
      provider: "openai",
      apiKey: "openai-secret",
      baseUrl: "https://speech.example/v1",
      model: "gpt-4o-mini-transcribe",
    });
  });

  it("uses the configured NavyAI key for its OpenAI-compatible audio endpoint", () => {
    expect(resolveTranscriptionRuntime({ NAVYAI_API_KEY: "navy-secret" })).toEqual({
      provider: "navy",
      apiKey: "navy-secret",
      baseUrl: "https://api.navy/v1",
      model: "whisper-1",
    });
  });

  it("stays disabled when no transcription credential exists", () => {
    expect(resolveTranscriptionRuntime({})).toBeNull();
  });
});
