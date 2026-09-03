import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("legal opportunities compact interface", () => {
  it("keeps monitoring compact while preserving live controls and metrics", () => {
    expect(source).toContain('data-ui="legal-monitoring-compact"');
    expect(source).toContain("Новых для вас");
    expect(source).toContain("Готовых материалов");
    expect(source).toContain("Последняя проверка");
    expect(source).toContain("Публиковать новые события автоматически");
    expect(source).toContain("Настроить профиль контента");
  });

  it("offers an accessible, independently controlled expanded news view", () => {
    expect(source).toContain('data-ui="legal-opportunity-card"');
    expect(source).toContain("const [expanded, setExpanded] = useState(false)");
    expect(source).toContain("aria-expanded={expanded}");
    expect(source).toContain("aria-controls={detailsId}");
    expect(source).toContain("expanded ? \"Свернуть подробности\" : \"Подробнее о событии\"");
    expect(source).toContain("Суть события");
    expect(source).toContain("Правовой контекст");
    expect(source).toContain("Идея подачи");
    expect(source).not.toContain("<details");
  });

  it("retains the three reversible item actions and the original source", () => {
    expect(source).toContain('data-aurora-action="saved"');
    expect(source).toContain('data-aurora-action="hidden"');
    expect(source).toContain('data-aurora-action="used"');
    expect(source).toContain("Открыть источник");
  });
});
