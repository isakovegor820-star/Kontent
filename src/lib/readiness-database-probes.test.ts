import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  schemaProbe: vi.fn(),
  tokenReadiness: vi.fn(),
  query: vi.fn(),
}));

vi.mock("./db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("./schema-readiness.mjs", () => ({ probeSchemaCompatibility: mocks.schemaProbe }));
vi.mock("./token-reencryption.mjs", () => ({ tokenEnvelopeKeyReadiness: mocks.tokenReadiness }));

import { probeDatabaseAndSchema } from "./readiness-probes";

describe("probeDatabaseAndSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgres://local/test";
    mocks.schemaProbe.mockResolvedValue({ ready: true, reasons: [] });
    mocks.tokenReadiness.mockResolvedValue({ state: "up" });
  });

  it("returns a healthy database with a bounded schema probe", async () => {
    const result = await probeDatabaseAndSchema();
    expect(result).toEqual({ database: "up", schema: { ready: true, reasons: [] }, tokenEncryption: "up" });
  });

  it("keeps the database up when only the token probe hangs beyond its budget", async () => {
    // Токен-проба зависает; бюджет (2с) переводит её в down, но успешно прочитанная
    // схема не маскируется как «база недоступна».
    mocks.tokenReadiness.mockImplementationOnce(() => new Promise(() => {}));
    const result = await probeDatabaseAndSchema();
    expect(result.database).toBe("up");
    expect(result.schema).toMatchObject({ ready: true });
    expect(result.tokenEncryption).toBe("down");
  }, 10_000);

  it("reports the database down when the schema probe itself hangs", async () => {
    mocks.schemaProbe.mockImplementationOnce(() => new Promise(() => {}));
    const result = await probeDatabaseAndSchema();
    expect(result.database).toBe("down");
    expect(result.schema).toMatchObject({ ready: false });
  }, 10_000);
});
