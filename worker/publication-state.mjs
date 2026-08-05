const NUMERIC_ID_NETWORKS = new Set(["tg", "vk"]);

/** Provider `ok` is not success unless it contains a durable external identifier. */
export function confirmedExternalId(network, result) {
  if (!result?.ok) return null;
  if (NUMERIC_ID_NETWORKS.has(network)) {
    const id = Number(result.externalId);
    return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  }
  const id = String(result.externalId ?? "").trim();
  return id ? id.slice(0, 500) : null;
}

export function publicationSuccessState(network, result) {
  const externalMessageId = confirmedExternalId(network, result);
  if (!externalMessageId) {
    return {
      ok: false,
      reason: result?.ok
        ? "Внешняя сеть не вернула подтверждённый id публикации"
        : String(result?.reason || "Внешняя сеть не подтвердила публикацию"),
    };
  }
  return {
    ok: true,
    externalMessageId,
    verificationState: "verified",
    verificationResult: { result: "provider_ack", network },
  };
}
