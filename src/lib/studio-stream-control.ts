export interface StudioStreamOwner {
  token: symbol;
  controller: AbortController;
}

export type StudioStreamBox = { current: StudioStreamOwner | null };

export function ownsStudioStream(box: StudioStreamBox, owner: StudioStreamOwner): boolean {
  return box.current?.token === owner.token;
}

/** A late finally block may clear only the controller it originally installed. */
export function beginStudioStream(box: StudioStreamBox): StudioStreamOwner {
  const owner = { token: Symbol("studio-stream"), controller: new AbortController() };
  box.current = owner;
  return owner;
}

export function clearStudioStream(box: StudioStreamBox, owner: StudioStreamOwner): boolean {
  if (!ownsStudioStream(box, owner)) return false;
  box.current = null;
  return true;
}

export function abortStudioStream(box: StudioStreamBox): StudioStreamOwner | null {
  const owner = box.current;
  if (!owner) return null;
  owner.controller.abort(new DOMException("Generation stopped by user", "AbortError"));
  if (ownsStudioStream(box, owner)) box.current = null;
  return owner;
}
