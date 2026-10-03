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
    // Таблицу заявок миграция создаёт сама: в базе со старой миграции её может не
    // быть, и тогда колонки согласия некуда добавить — а манифест их обещает,
    // поэтому гейт готовности схемы падал на capability_missing. Guard «если
    // таблица есть» эту дыру и создавал.
    expect(sql).toContain("create table if not exists leads");
    for (const column of ["consent_granted boolean", "consent_text_version text", "consent_at timestamptz"]) {
      expect(sql).toContain(column);
    }
    // Для базы, где leads уже есть без колонок согласия, нужен и ALTER.
    expect(sql).toContain("alter table leads add column if not exists consent_granted boolean");

    // Тело миграции обязано лежать в bootstrap-схеме: иначе свежая база получит
    // запись в ledger без объектов (migrate.mjs: bootstrap-снапшот). Сравниваем
    // целые операторы, а не строки: DDL в файлах переносится по-разному, и
    // построчное сравнение пропускает расхождение внутри многострочной таблицы.
    const statementsOf = (text: string) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("--"))
        .join("\n")
        // Операторы разделяются точкой с запятой; DO-блоков в файле нет.
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
    const bootstrapStatements = new Set(statementsOf(bootstrap));
    for (const statement of statementsOf(sql)) {
      // Управление транзакцией — часть миграции, в bootstrap-схеме его нет:
      // схема применяется одним куском, а begin/commit добавляет runner.
      if (statement === "begin" || statement === "commit") continue;
      expect(bootstrapStatements.has(statement), `нет в bootstrap-схеме: ${statement.slice(0, 60)}…`).toBe(true);
    }
  });

  it("keeps consent versions free of enumerations", async () => {
    const sql = await readFile(resolve(process.cwd(), MIGRATION), "utf8");
    // Версия текста и версия политики — text без CHECK: утверждённая редакция
    // меняет константу в коде, а не схему. Обратный пример в проекте уже был:
    // media_prompt_policy_version расширяли через drop constraint + allowlist.
    expect(sql).not.toMatch(/consent_text_version\s+text[^,]*check/iu);
    expect(sql).not.toMatch(/policy_version\s+text[^,]*check/iu);
    // Перечисление видов согласия проверяем только в самой таблице согласий:
    // в leads колонка kind — это вид контакта (email/telegram), и CHECK там
    // уместен. Раньше проверка шла по всему файлу и стала бы ложной.
    const consentsTable = sql.slice(
      sql.indexOf("create table if not exists consents"),
      sql.indexOf("create index if not exists consents_user_kind_idx"),
    );
    expect(consentsTable.length).toBeGreaterThan(0);
    expect(consentsTable).not.toMatch(/\bkind\s+text\s+not\s+null\s+check/iu);
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
