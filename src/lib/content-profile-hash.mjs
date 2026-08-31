import { createHash } from "node:crypto";

// The digest that decides whether a monthly campaign still matches the project it was built
// from. `updated_at` is deliberately absent: saving a channel brief without changing a single
// answer must not invalidate campaigns, and every column here is part of the brief itself.
export const CONTENT_PROFILE_HASH_SELECT = `
  select channel_id, niche, audience, rubrics, formats, author_role, goal, cta, taboo,
         profile_answers, quality, ready, source
    from content_brief
   where project_id = $1
   order by channel_id`;

export function contentProfileHash(rows) {
  return createHash("sha256")
    .update(JSON.stringify(Array.isArray(rows) ? rows : []), "utf8")
    .digest("hex");
}

export async function readContentProfileHash(db, projectId) {
  const result = await db.query(CONTENT_PROFILE_HASH_SELECT, [projectId]);
  return contentProfileHash(result?.rows ?? []);
}
