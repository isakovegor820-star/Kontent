import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SCHEMA_MANIFEST } from "./schema-manifest.mjs";

const MIGRATION = "db/migrations/20261026_consents.sql";

describe("consents migration", () => {
  it("is additive, transactional and mirrored by the bootstrap schema", async () => {
    const sql = await readFile(resolve(process.cwd(), MIGRATION), "utf8");
    const bootstrap = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");

    // Файл может начинаться с комментария — важна оболочка транзакции целиком.
    expect(sql).toMatch(/begin;[\s\S]*commit;\s*$/u);
    // Политика миграций запрещает разрушительные операции: журнал согласий
    // append-only, отзыв — новая строка, а не удаление.
    expect(sql).not.toMatch(/\bdrop\s+(?:table|column)\b|\btruncate\b|\bdelete\s+from\b/iu);
    expect(sql).toContain("create table if not exists consents");
    expect(sql).toContain("alter table leads add column if not exists consent_granted boolean");
    expect(sql).toContain("alter table leads add column if not exists consent_text_version text");
    expect(sql).toContain("alter table leads add column if not exists consent_at timestamptz");

    // Точное тело миграции обязано лежать в bootstrap-схеме: иначе свежая база
    // получит запись в ledger без объектов (migrate.mjs: bootstrap-снапшот).
    // Сравниваем DDL без комментариев: schema.sql собран из блоков, и пояснения
    // к колонкам там свои — значимо только то, что реально исполняется.
    const ddlOf = (text: string) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("--"))
        .join("\n");
    const bootstrapDdl = ddlOf(bootstrap);
    for (const statement of ddlOf(sql).split("\n")) {
      // Управление транзакцией — часть миграции, в bootstrap-схеме его нет:
      // схема применяется одним куском, а begin/commit добавляет runner.
      if (statement === "begin;" || statement === "commit;") continue;
      expect(bootstrapDdl).toContain(statement);
    }
  });

  it("keeps consent versions free of enumerations", async () => {
    const sql = await readFile(resolve(process.cwd(), MIGRATION), "utf8");
    // Версия текста и версия политики — text без CHECK: утверждённая редакция
    // меняет константу в коде, а не схему. Обратный пример в проекте уже был:
    // media_prompt_policy_version расширяли через drop constraint + allowlist.
    expect(sql).not.toMatch(/consent_text_version\s+text[^,]*check/iu);
    expect(sql).not.toMatch(/policy_version\s+text[^,]*check/iu);
    expect(sql).not.toMatch(/\bkind\s+text\s+not\s+null\s+check/iu);
  });

  it("is declared in the runtime schema manifest with its capabilities", () => {
    const names = SCHEMA_MANIFEST.migrations.map((migration) => migration.name);
    expect(names).toContain("20261026_consents.sql");
    expect(SCHEMA_MANIFEST.capabilities.tables).toContain("consents");
    for (const column of [
      "consents.kind",
      "consents.granted",
      "consents.granted_at",
      "consents.policy_version",
      "consents.consent_text_version",
      "leads.consent_granted",
    ]) {
      expect(SCHEMA_MANIFEST.capabilities.columns).toContain(column);
    }
    for (const index of ["consents.consents_user_kind_idx", "consents.consents_contact_kind_idx"]) {
      expect(SCHEMA_MANIFEST.capabilities.indexes).toContain(index);
    }
  });
});
