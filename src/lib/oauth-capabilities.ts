import { getProviderCapability, providerSupportsOperation } from "./provider-capabilities.mjs";

export const OAUTH_PROVIDER_IDS = ["youtube", "instagram"] as const;

export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

export type OAuthProviderCapability = {
  available: boolean;
  status: "available" | "not_configured" | "unsupported";
  reason: null | "server_not_configured" | "composer_unsupported";
  message: string | null;
};

/**
 * OAuth must remain deny-by-default until Composer can create a valid payload for
 * the network. Adding credentials or a worker adapter alone must not expose a
 * connection that the user cannot actually select and publish to.
 */
export function hasComposerPayloadSupport(network: string): boolean {
  return providerSupportsOperation(network, "livePublish");
}

export function isKnownOAuthProvider(network: string): network is OAuthProviderId {
  return (OAUTH_PROVIDER_IDS as readonly string[]).includes(network);
}

export function getOAuthProviderCapability(
  network: OAuthProviderId,
  configured: boolean,
): OAuthProviderCapability {
  const label = getProviderCapability(network)?.label ?? network;
  if (!hasComposerPayloadSupport(network)) {
    return {
      available: false,
      status: "unsupported",
      reason: "composer_unsupported",
      message: `Подключение ${label} станет доступно, когда публикация в ${label} появится в Композиторе.`,
    };
  }

  if (!configured) {
    return {
      available: false,
      status: "not_configured",
      reason: "server_not_configured",
      message: `Подключение ${label} не настроено на этом сервере.`,
    };
  }

  return { available: true, status: "available", reason: null, message: null };
}
