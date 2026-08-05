import fs from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getPool: vi.fn(),
  getStatsQueue: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: dependencies.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: dependencies.getPool }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: dependencies.getStatsQueue }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: dependencies.checkRateLimit,
  rateLimitResponse: vi.fn(),
}));

import { POST as createBotLink } from "./bot/link/route";
import { POST as collectStats } from "./stats/collect/route";

const MUTATION = /export async function (POST|PUT|PATCH|DELETE)\s*\([^)]*\)\s*\{/g;

function findRouteFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return findRouteFiles(fullPath);
    return entry.name === "route.ts" ? [fullPath] : [];
  });
}

function crossSite(pathname: string) {
  return new NextRequest(`https://aurora.test${pathname}`, {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
  });
}

describe("authenticated browser mutation origin coverage", () => {
  it("keeps origin rejection before every side effect in cookie-authenticated mutations", () => {
    const apiRoot = path.join(process.cwd(), "src/app/api");
    const uncovered: string[] = [];

    for (const file of findRouteFiles(apiRoot)) {
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes("getSessionUser") || !MUTATION.test(source)) {
        MUTATION.lastIndex = 0;
        continue;
      }
      MUTATION.lastIndex = 0;
      const matches = [...source.matchAll(MUTATION)];
      for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        const bodyStart = (match.index ?? 0) + match[0].length;
        const bodyEnd = matches[index + 1]?.index ?? source.length;
        const body = source.slice(bodyStart, bodyEnd);
        // A correlation ID may be allocated first so even the forbidden-origin response can
        // be traced. Keep the allowance deliberately narrow: no auth, request parsing,
        // database access, or other work may happen before the origin gate.
        if (
          !/^\s*(?:(?:const|let)\s+requestId(?::\s*string)?\s*=\s*(?:crypto\.)?randomUUID\(\);\s*)?if \(!hasTrustedMutationOrigin\((?:req|_req)\)\) \{/.test(
            body,
          )
        ) {
          uncovered.push(`${path.relative(apiRoot, file)}:${match[1]}`);
        }
      }
    }

    expect(uncovered).toEqual([]);
  });

  it.each([
    ["database-backed bot link", createBotLink, "/api/bot/link"],
    ["queued statistics collection", collectStats, "/api/stats/collect"],
  ])("rejects explicit cross-site %s before auth, database, rate limit, or queue", async (_label, handler, pathname) => {
    const response = await handler(crossSite(pathname));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden_origin" });
    expect(dependencies.getSessionUser).not.toHaveBeenCalled();
    expect(dependencies.getPool).not.toHaveBeenCalled();
    expect(dependencies.checkRateLimit).not.toHaveBeenCalled();
    expect(dependencies.getStatsQueue).not.toHaveBeenCalled();
  });
});
