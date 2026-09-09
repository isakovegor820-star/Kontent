import { decodeEntities, parseCount, sumReactions } from "./lib.mjs";

export function parseTelegramPublicPage(html) {
  const posts = [];
  const parts = String(html || "").split('data-post="');
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const messageMatch = block.match(/^[^/]+\/(\d+)"/);
    if (!messageMatch) continue;
    const timeMatch = block.match(/datetime="([^"]+)"/);
    const viewsMatch = block.match(/tgme_widget_message_views">([^<]+)</);
    const textMatch = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    let text = null;
    if (textMatch) {
      text = decodeEntities(textMatch[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
      if (!text) text = null;
    }
    const media = /tgme_widget_message_video/.test(block)
      ? "video"
      : /tgme_widget_message_photo/.test(block)
        ? "photo"
        : "text";
    const photoMatch = block.match(/tgme_widget_message_photo_wrap[^>]*background-image:url\('([^']+)'\)/);
    posts.push({
      msgId: Number(messageMatch[1]),
      text,
      media,
      photoUrl: photoMatch ? photoMatch[1] : null,
      views: viewsMatch ? parseCount(viewsMatch[1]) : null,
      reactions: sumReactions(block),
      postedAt: timeMatch ? timeMatch[1] : null,
    });
  }
  return posts;
}

