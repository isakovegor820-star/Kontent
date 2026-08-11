import type { Pool } from "pg";
import { ensureDefaultPersonalProjectInTransaction } from "./project-context";

export type PasswordRegistrationResult =
  | { ok: true; userId: number }
  | { ok: false; error: "email_taken" };

type RegistrationInput = {
  pool: Pick<Pool, "connect">;
  email: string;
  name: string;
  passwordHash: string;
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
