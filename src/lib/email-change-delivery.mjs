export function emailChangeDeliveryConfigured(env = process.env) {
  return Boolean(
    String(env.RESEND_API_KEY || env.EMAIL_API_KEY || "").trim()
      && String(env.EMAIL_CHANGE_FROM || env.EMAIL_FROM || "").trim(),
  );
}

export async function deliverEmailChangeEmail(
  input,
  { env = process.env, fetchImpl = fetch } = {},
) {
  const apiKey = String(env.RESEND_API_KEY || env.EMAIL_API_KEY || "").trim();
  const from = String(env.EMAIL_CHANGE_FROM || env.EMAIL_FROM || "").trim();
  if (!apiKey || !from) return { ok: false, code: "not_configured" };
  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": String(input.idempotencyKey).slice(0, 256),
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: "Подтверждение нового email в Авроре",
        text:
          "Подтвердите новый email для аккаунта Авроры. Ссылка действует один час и меняет адрес только один раз.\n\n" +
          `${input.confirmUrl}\n\n` +
          "Если вы не запрашивали изменение, просто проигнорируйте письмо.",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? { ok: true } : { ok: false, code: "provider_error" };
  } catch {
    return { ok: false, code: "network_error" };
  }
}
