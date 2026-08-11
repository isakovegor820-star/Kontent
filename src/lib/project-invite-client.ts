export const PROJECT_INVITE_STORAGE_KEY = "aurora.project.invite.v1";

export function projectInviteTokenFromHash(hash: string) {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  const token = new URLSearchParams(value).get("token") ?? "";
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

export function hasPendingProjectInvite(storage: Pick<Storage, "getItem"> | null | undefined) {
  try {
    return Boolean(storage && /^[A-Za-z0-9_-]{43}$/u.test(storage.getItem(PROJECT_INVITE_STORAGE_KEY) ?? ""));
  } catch {
    return false;
  }
}
