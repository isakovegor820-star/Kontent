export function passwordResetDeliveryConfigured(env = process.env) {
  return Boolean(
    String(env.RESEND_API_KEY || env.EMAIL_API_KEY || "").trim()
      && String(env.PASSWORD_RESET_FROM || env.EMAIL_FROM || "").trim(),
  );
}

export async function deliverPasswordResetEmail(
  input,
  { env = process.env, fetchImpl = fetch } = {},
) {
  const apiKey = String(env.RESEND_API_KEY || env.EMAIL_API_KEY || "").trim();
  const from = String(env.PASSWORD_RESET_FROM || env.EMAIL_FROM || "").trim();
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
        subject: "Восстановление доступа к Авроре",
        text:
          "Кто-то запросил смену пароля в Авроре. Ссылка действует 30 минут и сработает один раз.\n\n" +
          `${input.resetUrl}\n\n` +
          "Если это были не вы, просто проигнорируйте письмо.",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? { ok: true } : { ok: false, code: "provider_error" };
  } catch {
    return { ok: false, code: "network_error" };
  }
}
