import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

function functionSource(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  return source.slice(startIndex, source.indexOf(end, startIndex));
}

describe("competitors client confirmations", () => {
  it("does not report suggestion actions before the server confirms them", () => {
    const action = functionSource("const act = async", "if (loading) return null");
    const confirmation = action.indexOf("if (!response.ok || !data?.ok)");
    expect(confirmation).toBeGreaterThan(-1);
    expect(action.indexOf("setItems((prev)")).toBeGreaterThan(confirmation);
    expect(action.indexOf("kind: \"success\"")).toBeGreaterThan(confirmation);
  });

  it("keeps a competitor visible until deletion is confirmed", () => {
    const removal = functionSource("const remove = async", "return (");
    const confirmation = removal.indexOf("if (!response.ok || !data?.ok)");
    expect(confirmation).toBeGreaterThan(-1);
    expect(removal.indexOf("setList((prev)")).toBeGreaterThan(confirmation);
    expect(removal).toContain("Конкурент не удалён");
  });

  it("distinguishes an unavailable list from a confirmed empty list", () => {
    expect(source).toContain("if (!r.ok) throw new Error(\"competitors_unavailable\")");
    expect(source).toContain("if (!Array.isArray(d.competitors))");
    expect(source).toContain("Не удалось загрузить конкурентов");
    expect(source).toContain("listLoadError && list.length === 0 ? null");
  });
});
