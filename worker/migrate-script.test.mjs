import { describe, expect, it, vi } from "vitest";
import {
  assertBootstrappedDatabase,
  DatabaseNotBootstrappedError,
  migrate,
  migrationBody,
  migrationChecksum,
  REQUIRED_BASELINE_TABLES,
} from "../scripts/migrate.mjs";
import {
  MigrationPolicyError,
  prepareMigrationSet,
  validateMigrationSet,
} from "../scripts/migration-policy.mjs";

const VALID_MIGRATION = {
  name: "20260802_test_policy.sql",
  sql: "begin;\nselect 1;\ncommit;\n",
};

function mockPool(queryImplementation) {
  const client = {
    query: vi.fn(queryImplementation),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    end: vi.fn(async () => {}),
  };
  return { client, pool };
}

describe("migration runner helpers", () => {
  it("keeps the migration and ledger write in one runner transaction", () => {
    expect(migrationBody("-- additive\n\nbegin;\nselect 1;\ncommit;\n")).toBe("select 1;");
  });

  it("rejects a migration without the transactional envelope", () => {
    expect(() => migrationBody("select 1;")).toThrow(/BEGIN\/COMMIT/);
  });

  it("uses a stable content checksum", () => {
    expect(migrationChecksum("select 1")).toBe(migrationChecksum("select 1"));
    expect(migrationChecksum("select 1")).not.toBe(migrationChecksum("select 2"));
  });

  it("uses the same fail-closed policy for names, envelopes, and destructive SQL", () => {
    const failures = validateMigrationSet([
      { name: "bad name.sql", sql: "select 1" },
      {
        name: "20260802_destructive.sql",
        sql: "-- DELETE FROM in a comment is harmless\nbegin;\ndelete /* deliberate */ from users;\ncommit;",
      },
    ]);

    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("expected YYYYMMDD_snake_case.sql"),
        expect.stringContaining("enclosed by BEGIN/COMMIT"),
        expect.stringContaining("DELETE FROM"),
      ]),
    );
    expect(() => prepareMigrationSet([])).toThrow(MigrationPolicyError);
    expect(
      validateMigrationSet([
        {
          name: "20260802_nested_commit.sql",
          sql: "begin;\nselect 1;\ncommit;\ncommit;",
        },
      ]),
    ).toEqual([expect.stringContaining("transaction control")]);
  });

  it("allows only guarded, reviewed constraint replacements", () => {
    expect(
      validateMigrationSet([
        {
          name: "20260802_known_constraint.sql",
          sql: "begin;\nalter table posts drop constraint if exists posts_status_check;\ncommit;",
        },
      ]),
    ).toEqual([]);
    expect(
      validateMigrationSet([
        {
          name: "20260802_unknown_constraint.sql",
          sql: "begin;\nalter table users drop constraint users_email_key;\ncommit;",
        },
      ]),
    ).toEqual([expect.stringContaining("not allowlisted")]);
  });

  it("finishes policy validation before constructing a database pool", async () => {
    const poolFactory = vi.fn();

    await expect(
      migrate({
        env: { DATABASE_URL: "postgres://localhost/aurora" },
        migrations: [
          {
            name: "20260802_destructive.sql",
            sql: "begin;\ndrop table users;\ncommit;",
          },
        ],
        poolFactory,
      }),
    ).rejects.toBeInstanceOf(MigrationPolicyError);
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it("refuses an unbootstrapped database before creating the ledger", async () => {
    const { client, pool } = mockPool(async (sql) => {
      if (sql.includes("set_config")) return { rows: [{}] };
      if (sql.includes("from unnest")) return { rows: [{ name: "users" }, { name: "posts" }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(
      migrate({
        env: { DATABASE_URL: "postgres://localhost/aurora" },
        migrations: [VALID_MIGRATION],
        poolFactory: () => pool,
      }),
    ).rejects.toMatchObject({
      name: "DatabaseNotBootstrappedError",
      missing: ["posts", "users"],
    });

    expect(client.query.mock.calls.some(([sql]) => sql.includes("schema_migrations"))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("reports the complete set of missing baseline relations", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ name: "ai_usage" }, { name: "rss_items" }] })),
    };
    await expect(assertBootstrappedDatabase(client)).rejects.toBeInstanceOf(
      DatabaseNotBootstrappedError,
    );
  });

  it("requires every legacy relation altered by authentication, outbox, and media migrations", async () => {
    expect(REQUIRED_BASELINE_TABLES).toEqual(expect.arrayContaining([
      "sessions",
      "autopilot_plan",
      "media_generations",
    ]));
    const client = {
      query: vi.fn(async (_sql, [required]) => ({
        rows: required.includes("autopilot_plan") ? [{ name: "autopilot_plan" }] : [],
      })),
    };

    await expect(assertBootstrappedDatabase(client)).rejects.toMatchObject({
      name: "DatabaseNotBootstrappedError",
      missing: ["autopilot_plan"],
    });
  });

  it("closes the pool when connecting fails", async () => {
    const connectionError = new Error("connection unavailable");
    const pool = {
      connect: vi.fn(async () => {
        throw connectionError;
      }),
      end: vi.fn(async () => {}),
    };

    await expect(
      migrate({
        env: { DATABASE_URL: "postgres://localhost/aurora" },
        migrations: [VALID_MIGRATION],
        poolFactory: () => pool,
      }),
    ).rejects.toBe(connectionError);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("does not require SSL for a credential-free localhost URL", async () => {
    const connectionError = new Error("stop after config inspection");
    const pool = {
      connect: vi.fn(async () => {
        throw connectionError;
      }),
      end: vi.fn(async () => {}),
    };
    const poolFactory = vi.fn(() => pool);

    await expect(
      migrate({
        env: { DATABASE_URL: "postgres://localhost:55439/aurora" },
        migrations: [VALID_MIGRATION],
        poolFactory,
      }),
    ).rejects.toBe(connectionError);

    expect(poolFactory).toHaveBeenCalledWith(expect.objectContaining({ ssl: false }));
  });

  it("sets bounded timeouts, acquires a non-blocking lock, and records atomically", async () => {
    const queries = [];
    const { client, pool } = mockPool(async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("set_config")) return { rows: [{}] };
      if (sql.includes("from unnest")) return { rows: [] };
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql.includes("select checksum")) return { rows: [] };
      return { rows: [] };
    });
    const logger = { log: vi.fn() };

    await migrate({
      env: { DATABASE_URL: "postgres://localhost/aurora" },
      migrations: [VALID_MIGRATION],
      poolFactory: () => pool,
      logger,
    });

    const timeoutQuery = queries.find(({ sql }) => sql.includes("set_config"));
    expect(timeoutQuery.params).toEqual(["300000ms", "10000ms"]);
    expect(queries.some(({ sql }) => sql.includes("pg_try_advisory_lock"))).toBe(true);
    expect(queries.map(({ sql }) => sql)).toEqual(
      expect.arrayContaining([
        "begin",
        "select 1;",
        "insert into schema_migrations (name, checksum) values ($1, $2)",
        "commit",
      ]),
    );
    expect(logger.log).toHaveBeenCalledWith("[migrate] applied 20260802_test_policy.sql");
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
