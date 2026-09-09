import { headers } from "next/headers";

export const PROJECT_REQUEST_HEADER = "x-aurora-project-id";

/** Null is only the absence of a selector, never malformed or revoked input. */
export async function requestProjectId(): Promise<number | null> {
  let requestHeaders: Headers;
  try {
    requestHeaders = await headers();
  } catch (error) {
    // Helpers also run in worker/tests without a Next request; retain explicit server
    // semantics there. Other failures must not select a different workspace silently.
    if (error instanceof Error && error.message.includes("outside a request scope")) return null;
    throw error;
  }
  const raw = requestHeaders.get(PROJECT_REQUEST_HEADER);
  if (raw === null) return null;
  const id = Number(raw);
  if (!/^[1-9]\d*$/u.test(raw) || !Number.isSafeInteger(id)) {
    throw Object.assign(new Error("invalid_project_selector"), { code: "invalid_project_selector" });
  }
  return id;
}
