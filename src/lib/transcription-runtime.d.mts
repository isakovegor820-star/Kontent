export type TranscriptionRuntime = Readonly<{
  provider: "openai" | "navy";
  apiKey: string;
  baseUrl: string;
  model: string;
}>;

export function resolveTranscriptionRuntime(
  env?: Readonly<Record<string, string | undefined>>,
): TranscriptionRuntime | null;
