import type { Pool } from "pg";
import { CONSENT_TEXT_VERSION, POLICY_VERSION, recordConsent, type ConsentSource } from "./consent";
import { ensureDefaultPersonalProjectInTransaction } from "./project-context";

export type PasswordRegistrationResult =
  | { ok: true; userId: number }
  | { ok: false; error: "email_taken" };

/**
 * Согласие на обработку ПДн, полученное вместе с регистрацией.
 *
 * Передаётся в транзакцию создания пользователя: если запись согласия не
 * удалась, аккаунт не создаётся. Согласие без доказательства не имеет смысла,
 * а частично применённая регистрация оставила бы пользователя без основания
 * для обработки его данных.
 */
export type RegistrationConsent = {
  granted: boolean;
  ip: string | null;
  userAgent: string | null;
  source: ConsentSource;
  textVersion?: string;
  policyVersion?: string;
};

type RegistrationInput = {
  pool: Pick<Pool, "connect">;
  email: string;
  name: string;
  passwordHash: string;
  /** Есть — значит согласие получено и должно быть записано в этой же транзакции. */
  consent?: RegistrationConsent;
  /** Test-only transaction fault boundary. Production callers must not pass it. */
  afterInsert?: () => void | Promise<void>;
};

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

/** Creates the credential-bearing user in one transaction without attaching to an existing identity. */
export async function registerPasswordUser(input: RegistrationInput): Promise<PasswordRegistrationResult> {
  const client = await input.pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<{ id: number | string }>(
      `insert into users (email, name, password_hash)
       values ($1, $2, $3)
       on conflict (email) do nothing
       returning id`,
      [input.email, input.name, input.passwordHash],
    );
    if (!inserted.rows[0]) {
      await client.query("rollback");
      return { ok: false, error: "email_taken" };
    }
    const userId = Number(inserted.rows[0].id);
    await ensureDefaultPersonalProjectInTransaction(client, userId);
    // Согласие — в той же транзакции, что и аккаунт: доказательство основания
    // обработки не должно появляться отдельно от самой обработки.
    if (input.consent?.granted) {
      await recordConsent(client, {
        userId,
        kind: "pd_processing",
        granted: true,
        ip: input.consent.ip,
        userAgent: input.consent.userAgent,
        source: input.consent.source,
        consentTextVersion: input.consent.textVersion ?? CONSENT_TEXT_VERSION,
        policyVersion: input.consent.policyVersion ?? POLICY_VERSION,
      });
    }
    await input.afterInsert?.();
    await client.query("commit");
    return { ok: true, userId };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (isUniqueViolation(error)) return { ok: false, error: "email_taken" };
    throw error;
  } finally {
    client.release();
  }
}
