export interface GenerationFailureInput {
  surface: "text" | "media";
  code: string;
  engine?: string;
  requestId?: string;
  status?: number | null;
}
export function reportGenerationFailure(input: GenerationFailureInput): void;
