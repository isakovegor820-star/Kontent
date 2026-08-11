import { createHash } from "node:crypto";

export const REUSABLE_BLOCK_KINDS = [
  "author_signature",
  "contacts",
  "disclaimer",
  "cta",
  "sources",
  "first_comment",
] as const;

export type ReusableBlockKind = (typeof REUSABLE_BLOCK_KINDS)[number];
export type FirstCommentFallback = "append_to_post" | "skip";

export type ReusableBlock = {
  id: number;
  projectId: number;
  kind: ReusableBlockKind;
  name: string;
  text: string;
  version: number;
  enabled: boolean;
};

export type PublicationBlockSnapshot = {
  version: 1;
  body: string;
  renderedText: string;
  blocks: readonly {
    id: number;
    kind: ReusableBlockKind;
    name: string;
    text: string;
    version: number;
  }[];
  firstComment: {
    text: string;
    blockId: number;
    blockVersion: number;
    fallback: FirstCommentFallback;
    delivery: "provider_comment" | "appended" | "skipped";
  } | null;
  contentHash: string;
};

function validBlock(block: ReusableBlock, projectId: number) {
  return Number.isSafeInteger(block.id)
    && block.id > 0
    && block.projectId === projectId
    && REUSABLE_BLOCK_KINDS.includes(block.kind)
    && block.name.trim().length > 0
    && block.name.trim().length <= 120
    && block.text.trim().length > 0
    && block.text.trim().length <= 2_000
    && Number.isSafeInteger(block.version)
    && block.version > 0;
}

function joinParts(parts: readonly string[]) {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

export function buildPublicationBlockSnapshot(input: {
  projectId: number;
  body: string;
  selectedBlockIds: readonly number[];
  blocks: readonly ReusableBlock[];
  providerSupportsFirstComment: boolean;
  firstCommentFallback: FirstCommentFallback;
}): PublicationBlockSnapshot {
  const body = input.body.trim();
  if (!body) throw new Error("post_body_required");
  if (!Number.isSafeInteger(input.projectId) || input.projectId <= 0) throw new Error("invalid_project");
  if (!(["append_to_post", "skip"] as string[]).includes(input.firstCommentFallback)) {
    throw new Error("invalid_first_comment_fallback");
  }

  const byId = new Map(input.blocks.map((block) => [block.id, block]));
  const seen = new Set<number>();
  const selected = input.selectedBlockIds.map((id) => {
    if (seen.has(id)) throw new Error("duplicate_block_selection");
    seen.add(id);
    const block = byId.get(id);
    if (!block || !block.enabled || !validBlock(block, input.projectId)) throw new Error("block_unavailable");
    return block;
  });
  const firstComments = selected.filter((block) => block.kind === "first_comment");
  if (firstComments.length > 1) throw new Error("multiple_first_comments");
  const firstCommentBlock = firstComments[0] ?? null;
  const postBlocks = selected.filter((block) => block.kind !== "first_comment");

  let delivery: PublicationBlockSnapshot["firstComment"] extends infer T
    ? T extends { delivery: infer D } ? D : never
    : never = "provider_comment";
  if (!input.providerSupportsFirstComment) {
    delivery = input.firstCommentFallback === "append_to_post" ? "appended" : "skipped";
  }
  const renderedText = joinParts([
    body,
    ...postBlocks.map((block) => block.text),
    ...(firstCommentBlock && delivery === "appended" ? [firstCommentBlock.text] : []),
  ]);

  const blocks = selected.map((block) => ({
    id: block.id,
    kind: block.kind,
    name: block.name.trim(),
    text: block.text.trim(),
    version: block.version,
  }));
  const firstComment = firstCommentBlock
    ? {
        text: firstCommentBlock.text.trim(),
        blockId: firstCommentBlock.id,
        blockVersion: firstCommentBlock.version,
        fallback: input.firstCommentFallback,
        delivery,
      }
    : null;
  const canonical = JSON.stringify({ version: 1, body, renderedText, blocks, firstComment });
  return {
    version: 1,
    body,
    renderedText,
    blocks,
    firstComment,
    contentHash: createHash("sha256").update(canonical).digest("hex"),
  };
}
