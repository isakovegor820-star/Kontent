import { createHash } from "node:crypto";
import { toTelegramHtml } from "./telegram-format.mjs";
import { normalizeRichTextEntities } from "./rich-text.mjs";
import { buildTelegramPayload, buildTelegramCarouselParts, parseTelegramHtml } from "./telegram-payload.mjs";

/** Persist the exact rich text/media plan reviewed in Composer, before queue delivery. */
export async function persistAutopilotEditorPayload(db, postId, item) {
  if (!item.editorVersion) return;
  const media = item.media;
  const parts = media?.kind === "carousel"
    ? buildTelegramCarouselParts({ assetCount: media.items?.length, text: item.draft, entities: item.formatting ?? [] })
    : buildTelegramPayload({ text: item.draft, entities: item.formatting ?? [], hasAsset: Number(media?.assetId) > 0 }).parts;
  for (const part of parts) {
    const hash = createHash("sha256").update(`${part.type}\0${part.payloadHtml || ""}`).digest("hex");
    await db.query(
      `insert into publication_parts (post_id, part_index, part_type, payload_html, payload_hash, entity_length)
       values ($1, $2, $3, $4, $5, $6)`,
      [postId, part.index, part.type, part.payloadHtml, hash, part.entityLength],
    );
  }
}

export function autopilotEditorPostHash(post) {
  return createHash("sha256").update(JSON.stringify([
    post.text, post.media ?? null, new Date(post.scheduled_at).toISOString(), Number(post.schedule_revision),
  ])).digest("hex");
}

/** Bring generated bold/spoiler markup into the same plain-text/entity model as Composer. */
export function autopilotEditorContent(value, formatting) {
  if (Array.isArray(formatting)) return { text: String(value ?? ""), formatting };
  const atoms = parseTelegramHtml(toTelegramHtml(String(value ?? "")));
  let text = "";
  const entities = [];
  const last = new Map();
  for (const atom of atoms) {
    const offset = text.length;
    for (const style of atom.styles) {
      const previous = last.get(style.key);
      if (previous && previous.offset + previous.length === offset) previous.length += atom.length;
      else {
        const entity = { type: style.type, offset, length: atom.length };
        entities.push(entity); last.set(style.key, entity);
      }
    }
    text += atom.text;
  }
  return { text, formatting: normalizeRichTextEntities(text, entities) };
}
