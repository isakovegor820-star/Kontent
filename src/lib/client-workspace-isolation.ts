import type { AppState } from "./types";

const STORAGE_PREFIX = "aurora.state.v2";

export type ClientWorkspaceIdentity = Readonly<{
  userId: number;
  projectId: number;
}>;

export type WorkspaceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type WorkspaceRequestTicket = Readonly<{
  sequence: number;
  identity: string;
  signal: AbortSignal;
}>;

export type WorkspaceRequestFence = Readonly<{
  start: (identity: string) => WorkspaceRequestTicket;
  invalidate: () => void;
  isCurrent: (ticket: WorkspaceRequestTicket, currentIdentity: string | null) => boolean;
}>;

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function workspaceIdentityKey(identity: ClientWorkspaceIdentity): string {
  if (!positiveId(identity.userId) || !positiveId(identity.projectId)) {
    throw new Error("invalid_workspace_identity");
  }
  return `user:${identity.userId}:project:${identity.projectId}`;
}

export function workspaceStorageKey(identity: ClientWorkspaceIdentity): string {
  return `${STORAGE_PREFIX}:${workspaceIdentityKey(identity)}`;
}

/**
 * Only the dedicated server-owned current-project response may establish a workspace.
 * Event payloads and arbitrary client project ids intentionally do not match this shape.
 */
export function parseServerSelectedProjectId(value: unknown): number | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.project)) return null;
  const projectId = Number(value.project.projectId);
  return positiveId(projectId) ? projectId : null;
}

export function isStoredAppState(value: unknown): value is AppState {
  if (!isRecord(value) || !isRecord(value.settings)) return false;
  return (
    Array.isArray(value.channels)
    && Array.isArray(value.posts)
    && Array.isArray(value.competitors)
    && Array.isArray(value.trends)
    && Array.isArray(value.autopilot)
    && Array.isArray(value.waitlist)
  );
}

export function readWorkspaceState(
  storage: WorkspaceStorage,
  identity: ClientWorkspaceIdentity,
): AppState | null {
  try {
    const raw = storage.getItem(workspaceStorageKey(identity));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredAppState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeWorkspaceState(
  storage: WorkspaceStorage,
  identity: ClientWorkspaceIdentity,
  state: AppState,
): void {
  const persisted: AppState = { ...state, user: null };
  storage.setItem(workspaceStorageKey(identity), JSON.stringify(persisted));
}

export function removeWorkspaceState(
  storage: WorkspaceStorage,
  identity: ClientWorkspaceIdentity,
): void {
  storage.removeItem(workspaceStorageKey(identity));
}

/** Abort + sequence + identity fencing for requests whose response mutates visible state. */
export function createWorkspaceRequestFence(): WorkspaceRequestFence {
  let sequence = 0;
  let controller: AbortController | null = null;

  return {
    start(identity) {
      controller?.abort();
      controller = new AbortController();
      sequence += 1;
      return { sequence, identity, signal: controller.signal };
    },
    invalidate() {
      sequence += 1;
      controller?.abort();
      controller = null;
    },
    isCurrent(ticket, currentIdentity) {
      return (
        !ticket.signal.aborted
        && ticket.sequence === sequence
        && ticket.identity === currentIdentity
      );
    },
  };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
