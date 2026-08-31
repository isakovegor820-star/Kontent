import pg from "pg";

import { rebaseLegacyProfileHashes } from "../src/lib/content-profile-hash-backfill.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString, max: 2 });
try {
  const totals = await rebaseLegacyProfileHashes({
    pool,
    onProject: (report) => {
      if (!report.campaigns && !report.plans && !report.operations) return;
      console.log("[monthly_profile_rebase] project", {
        projectId: report.projectId,
        campaigns: report.campaigns,
        plans: report.plans,
        operations: report.operations,
      });
    },
  });
  console.log("[monthly_profile_rebase] done", totals);
} finally {
  await pool.end();
}
