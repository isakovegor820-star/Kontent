import { decryptToken, encryptToken } from "./token-crypto.mjs";

export const OAUTH_STATE_MAX_AGE_S = 600;
export type OAuthState = {
  state: string;
  verifier: string;
  network: string;
  userId: number;
  projectId: number;
  expiresAt: number;
};

/** Authenticate the project and PKCE binding with the existing rotating token keyring. */
export function sealOAuthState(input: Omit<OAuthState, "expiresAt">, now = Date.now()): string {
  return encryptToken(JSON.stringify({ ...input, expiresAt: now + OAUTH_STATE_MAX_AGE_S * 1000 }), {
    userId: input.userId, provider: `oauth-state:${input.network}`,
  });
}

export function openOAuthState(raw: string, userId: number, network: string, now = Date.now()): OAuthState | null {
  try {
    const saved = JSON.parse(decryptToken(raw, { userId, provider: `oauth-state:${network}` })) as OAuthState;
    if (!saved || saved.userId !== userId || saved.network !== network
      || !Number.isSafeInteger(saved.projectId) || saved.projectId <= 0
      || typeof saved.state !== "string" || !saved.state
      || typeof saved.verifier !== "string" || !saved.verifier
      || !Number.isSafeInteger(saved.expiresAt) || saved.expiresAt <= now
      || saved.expiresAt > now + OAUTH_STATE_MAX_AGE_S * 1000) return null;
    return saved;
  } catch { return null; }
}
