import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { describe, expect, it } from "vitest";
import policies from "./project-route-policies.json";
import { isProjectHttpRequest } from "./project-http-policy";

describe("project HTTP boundary inventory", () => {
  it("covers every explicit route export and wraps every project method", () => {
    const root = resolve("src/app/api");
    const actual: string[] = [];
    for (const name of readdirSync(root, { recursive: true }) as string[]) {
      if (!name.endsWith("/route.ts") && name !== "route.ts") continue;
      const path = `/api/${relative(root, resolve(root, name)).replace(/\/route\.ts$/u, "")}`;
      const source = readFileSync(resolve(root, name), "utf8");
      const methods = [...source.matchAll(/export\s+(?:async function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gu)].map((match) => match[1]);
      for (const method of methods) {
        actual.push(`${method} ${path}`);
        const policy = policies.find((row) => row.path === path && row.method === method);
        expect(policy, `${method} ${path}`).toBeDefined();
        if (policy?.policy === "project") {
          expect(source).toContain(`export const ${method} = withProjectRoute(`);
        }
      }
    }
    expect(actual.sort()).toEqual(policies.map((row) => `${row.method} ${row.path}`).sort());
  });
  it("keeps context recovery independent from the dynamic project object route", () => {
    expect(isProjectHttpRequest("/api/projects/current", "GET")).toBe(false);
    expect(isProjectHttpRequest("/api/projects/current", "PATCH")).toBe(true);
    expect(isProjectHttpRequest("/api/projects/11", "GET")).toBe(true);
    expect(isProjectHttpRequest("/api/channels", "HEAD")).toBe(true);
    expect(isProjectHttpRequest("/api/tracking/ping", "OPTIONS")).toBe(false);
  });
});
