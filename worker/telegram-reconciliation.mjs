function decodeTelegramText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#0?39;/gu, "'")
    .replace(/&nbsp;/gu, " ")
    .replace(/&#(\d+);/gu, (_, codePoint) => {
      try { return String.fromCodePoint(Number(codePoint)); } catch { return ""; }
    })
    .replace(/&amp;/gu, "&")
    .trim();
}

/** Parse the public Telegram channel page without assigning publication truth yet. */
export function parseTelegramPublicStats(html, parseCount, sumReactions) {
  const messages = {};
  const posts = [];
  const parts = String(html || "").split('data-post="');
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const message = block.match(/^[^/]+\/(\d+)"/);
    if (!message) continue;
    const messageId = Number(message[1]);
    const views = block.match(/tgme_widget_message_views">([^<]+)</);
    messages[messageId] = {
      views: views ? parseCount(views[1]) : null,
      reactions: sumReactions(block),
    };
    const text = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/u);
    const datetime = block.match(/datetime="([^"]+)"/u);
    posts.push({
      externalMessageId: messageId,
      text: text ? decodeTelegramText(text[1]) : "",
      publishedAt: datetime && Number.isFinite(Date.parse(datetime[1])) ? new Date(datetime[1]).toISOString() : null,
    });
  }
  const ids = Object.keys(messages).map(Number);
  return {
    kind: ids.length ? "window" : "unverifiable",
    messages,
    posts,
    oldestSeen: ids.length ? Math.min(...ids) : null,
  };
}

/** A network/provider failure is not evidence that a message was deleted. */
export function temporaryTelegramVerification(errorCode, reason) {
  return {
    kind: "temporary_error",
    messages: {},
    oldestSeen: null,
    errorCode: String(errorCode || "telegram_unavailable").slice(0, 80),
    reason: String(reason || "Telegram verification is temporarily unavailable").slice(0, 500),
  };
}

export function decideTelegramReconciliation({
  externalMessageId,
  result,
  consecutiveMissingChecks = 0,
  confirmationsRequired = 2,
}) {
  const messageId = Number(externalMessageId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return { kind: "unverifiable", errorCode: "invalid_external_id" };
  }
  if (result.kind === "temporary_error") {
    return {
      kind: "temporary_error",
      errorCode: result.errorCode,
      reason: result.reason,
    };
  }
  if (result.kind !== "window" || result.oldestSeen == null) {
    return { kind: "unverifiable", errorCode: "public_feed_empty" };
  }
  const metrics = result.messages[messageId];
  if (metrics) return { kind: "seen", metrics };
  if (messageId < result.oldestSeen) return { kind: "out_of_window" };

  const missingChecks = Math.max(0, Number(consecutiveMissingChecks) || 0) + 1;
  return missingChecks >= confirmationsRequired
    ? { kind: "confirmed_missing", missingChecks }
    : { kind: "suspected_missing", missingChecks };
}

export function decideTelegramAggregateReconciliation({
  parts,
  result,
  consecutiveMissingChecks = 0,
  confirmationsRequired = 2,
}) {
  const eligible = Array.isArray(parts)
    ? parts.filter((part) => part?.send_status === "sent" && part?.external_message_id)
    : [];
  if (!eligible.length) return { kind: "unverifiable", errorCode: "missing_publication_parts" };
  const decisions = eligible.map((part) => ({
    partIndex: Number(part.part_index),
    externalMessageId: String(part.external_message_id),
    decision: decideTelegramReconciliation({
      externalMessageId: part.external_message_id,
      result,
      consecutiveMissingChecks,
      confirmationsRequired,
    }),
  }));
  const temporary = decisions.find((item) => item.decision.kind === "temporary_error");
  if (temporary) return { ...temporary.decision, partDecisions: decisions };
  const missing = decisions.find((item) => item.decision.kind === "confirmed_missing");
  if (missing) {
    return {
      kind: "confirmed_missing",
      missingChecks: missing.decision.missingChecks,
      missingPartIndexes: decisions
        .filter((item) => item.decision.kind === "confirmed_missing")
        .map((item) => item.partIndex),
      partDecisions: decisions,
    };
  }
  const suspected = decisions.find((item) => item.decision.kind === "suspected_missing");
  if (suspected) return { ...suspected.decision, partDecisions: decisions };
  if (decisions.every((item) => item.decision.kind === "seen")) {
    const metrics = decisions.map((item) => item.decision.metrics);
    return {
      kind: "seen",
      metrics: {
        views: metrics.some((item) => item.views != null)
          ? Math.max(...metrics.map((item) => Number(item.views) || 0))
          : null,
        reactions: metrics.some((item) => item.reactions != null)
          ? metrics.reduce((sum, item) => sum + (Number(item.reactions) || 0), 0)
          : null,
      },
      partDecisions: decisions,
    };
  }
  return { kind: "unverifiable", errorCode: "publication_part_out_of_window", partDecisions: decisions };
}
