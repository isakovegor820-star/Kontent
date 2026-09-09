import { captureEvent } from "@sentry/node";

const safeLabel = (value) => typeof value === "string" && /^[a-z0-9_:-]{1,80}$/u.test(value)
  ? value : "unknown";

/** Only bounded diagnostic labels reach Sentry; no prompt, response or raw Error. */
export function generationFailureEvent(input) {
  const surface = input.surface === "media" ? "media" : "text";
  const code = safeLabel(input.code);
  const engine = safeLabel(input.engine);
  const requestId = typeof input.requestId === "string"
    && /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/iu.test(input.requestId) ? input.requestId : undefined;
  return {
    level: "error",
    message: `Aurora ${surface} generation failed: ${code}`,
    fingerprint: ["aurora-generation", surface, code, engine],
    tags: { component: "content_generation", surface, code, engine },
    extra: {
      ...(requestId ? { requestId } : {}),
      ...(Number.isInteger(input.status) && input.status >= 400 && input.status <= 599
        ? { httpStatus: input.status } : {}),
    },
  };
}

export function reportGenerationFailure(input, report = captureEvent) {
  try { report(generationFailureEvent(input)); } catch { /* Telemetry cannot break recovery. */ }
}
