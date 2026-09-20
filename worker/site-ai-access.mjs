import { AiWorkAccessError, requireAiWorkAccess } from "../src/lib/ai-work-access.mjs";

/** Call inside a short transaction, never across provider HTTP. */
export async function requireSiteAiAccess(db, { siteId, userId, projectId }) {
  await requireAiWorkAccess(db, { userId, projectId });
  const site = (await db.query(`select id from sites where id=$1 and project_id=$2 and status='active' for share`, [siteId, projectId])).rows[0];
  if (!site) throw new AiWorkAccessError();
}

export async function withSiteAiAccess(pool, scope, task) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await requireSiteAiAccess(client, scope);
    const result = await task(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally { client.release(); }
}

/** This reads identifiers only. A missing legacy requester is held for reauthorization. */
export async function siteAiScope(pool, siteId, userId) {
  const site = (await pool.query("select project_id from sites where id=$1", [siteId])).rows[0];
  if (!site) throw new AiWorkAccessError();
  return { siteId: Number(siteId), projectId: Number(site.project_id), userId: Number(userId) };
}
