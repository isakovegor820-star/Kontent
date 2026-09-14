import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");

function between(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`worker block not found: ${start}`);
  return source.slice(startIndex, endIndex);
}

describe("publication worker project isolation contract", () => {
  it("binds every provider delivery to the immutable post project", () => {
    const block = between("const worker = AUTOPILOT_ONLY", 'worker?.on("ready"');

    expect(block).toContain("let projectId = Number(job.data.projectId)");
    expect(block).toContain("select project_id from posts where id = $1");
    expect(block).toContain("claimPublicationLease(pool, {\n      postId,\n      projectId,");
    expect(block).toContain("from channels where id = $1 and project_id = $2");
    expect(block).toContain("beginProviderCall(pool, {\n      postId,\n      projectId,");
    expect(block).toContain("{ postId, projectId, scheduleRevision }");
  });

  it("adds projectId to new and reconciled queue jobs", () => {
    const enqueueBlock = between("async function enqueuePublishJob", "// Вставить scheduled-пост");
    const reconcileBlock = between("async function reconcileScheduledPosts()", "// Graceful shutdown");

    expect(enqueueBlock).toContain("select project_id from posts where id = $1");
    expect(enqueueBlock).toContain("{ postId, projectId, scheduleRevision }");
    expect(reconcileBlock).toContain("select p.id, p.project_id");
    expect(reconcileBlock).toContain("projectId: Number(post.project_id)");
  });
});
