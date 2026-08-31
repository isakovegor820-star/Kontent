export class AiClientStreamTimeoutError extends Error {
  constructor(public readonly kind: "idle" | "overall") {
    super(kind === "idle" ? "ai_stream_idle_timeout" : "ai_stream_overall_timeout");
    this.name = "AiClientStreamTimeoutError";
  }
}

export async function readAiStreamWithDeadline(input: {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  onChunk: (chunk: Uint8Array) => void;
  idleTimeoutMs: number;
  overallTimeoutMs: number;
  now?: () => number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const startedAt = now();

  while (true) {
    const overallRemaining = input.overallTimeoutMs - (now() - startedAt);
    if (overallRemaining <= 0) throw new AiClientStreamTimeoutError("overall");
    const timeoutMs = Math.min(input.idleTimeoutMs, overallRemaining);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        input.reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AiClientStreamTimeoutError(
            overallRemaining <= input.idleTimeoutMs ? "overall" : "idle",
          )), timeoutMs);
        }),
      ]);
      if (result.done) return;
      if (result.value?.byteLength) input.onChunk(result.value);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
