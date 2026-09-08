export const PROJECT_INVITE_STORAGE_KEY = "aurora.project.invite.v1";

type InviteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function projectInviteStorage(): InviteStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function projectInviteTokenFromHash(hash: string) {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  const tokens = new URLSearchParams(value).getAll("token");
  const token = tokens.length === 1 ? tokens[0] : "";
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

export function saveProjectInviteToken(token: string, storage = projectInviteStorage()) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
  try {
    if (!storage) return false;
    storage.setItem(PROJECT_INVITE_STORAGE_KEY, token);
    return storage.getItem(PROJECT_INVITE_STORAGE_KEY) === token;
  } catch {
    return false;
  }
}

export function clearProjectInviteToken(storage = projectInviteStorage(), expectedToken?: string) {
  try {
    if (!storage) return false;
    // A late response for an earlier invitation must not remove a newer one.
    if (expectedToken && storage.getItem(PROJECT_INVITE_STORAGE_KEY) !== expectedToken) return true;
    storage.removeItem(PROJECT_INVITE_STORAGE_KEY);
    return storage.getItem(PROJECT_INVITE_STORAGE_KEY) === null;
  } catch {
    return false;
  }
}

export function readProjectInvite(hash: string, storage = projectInviteStorage()) {
  if (hash && hash !== "#main") {
    const token = projectInviteTokenFromHash(hash);
    // An explicitly supplied but invalid link must never fall back to an old token.
    const stored = token ? saveProjectInviteToken(token, storage) : clearProjectInviteToken(storage);
    return { token, stored };
  }
  try {
    const value = storage?.getItem(PROJECT_INVITE_STORAGE_KEY) ?? "";
    return { token: /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null, stored: Boolean(storage) };
  } catch {
    return { token: null, stored: false };
  }
}

export function hasPendingProjectInvite(storage: Pick<Storage, "getItem"> | null | undefined) {
  try {
    return Boolean(storage && /^[A-Za-z0-9_-]{43}$/u.test(storage.getItem(PROJECT_INVITE_STORAGE_KEY) ?? ""));
  } catch {
    return false;
  }
}
