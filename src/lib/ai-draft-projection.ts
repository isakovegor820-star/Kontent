import type { AiStreamEvent } from "./ai-stream";

export type AiDraftPhase = "draft" | "editing" | "writing";

export type AiDraftProjection = {
  /** Current provider pass. It may be empty while the next pass is starting. */
  buffer: string;
  /** Last complete/useful candidate shown to the person. Never cleared by a pass reset. */
  visibleText: string;
  phase: AiDraftPhase | null;
  hasStableCandidate: boolean;
};

export function createAiDraftProjection(initialText = ""): AiDraftProjection {
  const text = String(initialText);
  return {
    // The existing draft is a recovery candidate, not part of the new provider pass.
    // Otherwise the first streamed delta would be appended to the old post.
    buffer: "",
    visibleText: text,
    phase: null,
    hasStableCandidate: Boolean(text.trim()),
  };
}

/**
 * Editorial generation has several provider passes. The protocol resets its pass buffer
 * with `replace("")`; that is not a request to erase the user's visible draft. Promote a
 * completed pass when the next phase starts, then keep it visible until the next full
 * candidate is ready.
 */
export function projectAiDraftEvent(
  current: AiDraftProjection,
  event: AiStreamEvent,
): AiDraftProjection {
  if (event.type === "phase") {
    const candidate = current.buffer.trim() ? current.buffer : current.visibleText;
    return {
      ...current,
      visibleText: candidate,
      phase: event.phase,
      hasStableCandidate: current.hasStableCandidate || Boolean(current.buffer.trim()),
    };
  }

  if (event.type === "replace") {
    if (!event.text) return { ...current, buffer: "" };
    return {
      ...current,
      buffer: event.text,
      visibleText: event.text,
      hasStableCandidate: true,
    };
  }

  if (event.type === "delta") {
    const buffer = current.buffer + event.text;
    const keepStableCandidate = current.hasStableCandidate;
    return {
      ...current,
      buffer,
      visibleText: keepStableCandidate ? current.visibleText : buffer,
    };
  }

  if (event.type === "done" && current.buffer.trim()) {
    return {
      ...current,
      visibleText: current.buffer,
      hasStableCandidate: true,
    };
  }

  return current;
}

export function aiDraftPhaseLabel(phase: AiDraftPhase | null): string {
  if (phase === "draft") return "Собираю первый черновик…";
  if (phase === "editing") return "Улучшаю текст — текущий черновик остаётся на месте…";
  return "Пишу текст…";
}
