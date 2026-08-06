function configuredMs(
  name: string,
  fallback: number,
  env: Record<string, string | undefined>,
): number {
  const value = Number(env[name]);
  return Number.isFinite(value) ? Math.min(300_000, Math.max(100, Math.round(value))) : fallback;
}

export function generationDeadlines(
  mode: "fast" | "balanced" | "maximum",
  env: Record<string, string | undefined> = process.env,
) {
  if (mode === "fast") {
    return {
      firstTokenMs: configuredMs("AI_FAST_FIRST_TOKEN_MS", 30_000, env),
      attemptOverallMs: configuredMs("AI_FAST_OVERALL_MS", 90_000, env),
      pipelineOverallMs: configuredMs("AI_FAST_PIPELINE_MS", 90_000, env),
    };
  }
  if (mode === "maximum") {
    return {
      firstTokenMs: configuredMs("AI_MAX_FIRST_TOKEN_MS", 60_000, env),
      attemptOverallMs: configuredMs("AI_MAX_ATTEMPT_MS", 120_000, env),
      pipelineOverallMs: configuredMs("AI_MAX_PIPELINE_MS", 300_000, env),
    };
  }
  return {
    // NavyAI can remain healthy while model startup takes longer than 12 seconds.
    // Keep the selected engine and wait for a realistic TTFT instead of false-failing.
    firstTokenMs: configuredMs("AI_BALANCED_FIRST_TOKEN_MS", 60_000, env),
    attemptOverallMs: configuredMs("AI_BALANCED_ATTEMPT_MS", 120_000, env),
    // Draft, verification and editorial passes are a single paid operation. NavyAI may
    // legitimately need more than 150 seconds for all passes even though every attempt
    // remains healthy, so the pipeline must not cut off a nearly finished post.
    pipelineOverallMs: configuredMs("AI_BALANCED_PIPELINE_MS", 300_000, env),
  };
}
