// План автопилота внутри ОСНОВНОГО календаря.
//
// Автопилот намеренно не создаёт посты сам: элементы живут в autopilot_plan.items,
// пока человек не подтвердит их (docs/publication-authority.md, `fullAtCommit=false`).
// Из-за этого неделя в основном календаре выглядела пустой, хотя план уже собран и
// распределён по дням. Этот модуль — чистая, без побочных эффектов, проекция плана в
// карточки календаря: человек видит весь план там, где планирует неделю, но публикация
// по-прежнему требует явного подтверждения.
//
// Единственный источник правды о том, «можно ли добавить» — evaluateAutopilotItem из
// autopilot-approval.mjs (тот же вердикт, что использует серверное подтверждение).

import { evaluateAutopilotItem } from "./autopilot-approval.mjs";
import { sanitizeAutopilotPublicText } from "./autopilot-publication.mjs";

/** Верхняя граница, чтобы один план не раздул ответ календаря. */
export const AUTOPILOT_CALENDAR_PLAN_LIMIT = 200;

const asText = (value) => (typeof value === "string" ? value : "");

function uniqueBlockers(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry !== "object") continue;
      const code = asText(entry.code) || "blocked";
      const message = asText(entry.message).trim();
      const key = `${code}\u0000${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ code, message });
    }
  }
  return merged;
}

/**
 * Состояние одного элемента плана в календаре.
 * ready   — можно добавить в основной календарь (кнопка активна);
 * expired — время прошло, нужно новое время;
 * blocked — нужна проверка/правки в автопилоте, добавление недоступно.
 */
export function autopilotPlanItemState({ item, evaluation, planStatus }) {
  const status = asText(item?.status);
  const blockers = uniqueBlockers(item?.approvalBlockers, evaluation?.blockers);
  const expired =
    status === "expired" ||
    blockers.some((entry) => entry.code === "expired" || entry.code === "invalid_schedule");
  const ready = evaluation?.actionable === true && evaluation?.eligible === true;
  const state = expired ? "expired" : ready ? "ready" : "blocked";
  const issues = blockers.map((entry) => entry.message).filter(Boolean);
  if (state === "blocked" && issues.length === 0) issues.push("Пост требует проверки в автопилоте.");
  if (state === "expired" && issues.length === 0) {
    issues.push("Время публикации прошло. Выбери новую дату и время.");
  }
  return {
    state,
    issues,
    statusLabel:
      state === "ready"
        ? "Не подтверждён"
        : state === "expired"
          ? "Нужно новое время"
          : "Нужна проверка",
    // Подтверждение доступно только у живого pending-плана: approval operation
    // принимает исключительно status = 'pending' (см. createStoredPreview).
    selectable: Boolean(ready && planStatus === "pending"),
    // Перенос времени умеет /api/autopilot/item/schedule только у pending/approved плана.
    editable:
      (status === "pending" || status === "expired") &&
      (planStatus === "pending" || planStatus === "approved"),
  };
}

/**
 * Проекция активных планов канала в плоский список карточек основного календаря.
 * Элементы, уже ставшие постом (postId), сюда не попадают — их показывает реальная
 * карточка публикации из /api/posts, дублировать её в календаре нельзя.
 */
export function autopilotPlanCalendarItems({
  plans,
  nowMs = Date.now(),
  canPublish = false,
  canEdit = false,
  limit = AUTOPILOT_CALENDAR_PLAN_LIMIT,
  draftVersions = null,
} = {}) {
  const bound = Math.max(1, Math.min(1_000, Number(limit) || AUTOPILOT_CALENDAR_PLAN_LIMIT));
  const rows = Array.isArray(plans) ? plans : [];
  // Пустая карта — не «версий нет», а «проверку не выполняли»: тогда поведение прежнее.
  const versionsKnown = draftVersions instanceof Map;
  const versions = versionsKnown ? draftVersions : new Map();
  const output = [];
  for (const plan of rows) {
    const planId = Number(plan?.id);
    if (!Number.isSafeInteger(planId) || planId <= 0) continue;
    const planRevision = Number(plan?.revision);
    const channelId = Number(plan?.channel_id);
    const planStatus = asText(plan?.status);
    const items = Array.isArray(plan?.items) ? plan.items : [];
    for (const item of items) {
      if (output.length >= bound) return output;
      const index = Number(item?.i);
      if (!Number.isSafeInteger(index) || index < 0) continue;
      if (Number(item?.postId) > 0) continue;
      const status = asText(item?.status);
      if (status !== "pending" && status !== "expired") continue;
      const scheduledAt = asText(item?.scheduledAt);
      if (!scheduledAt || !Number.isFinite(Date.parse(scheduledAt))) continue;

      // Тот же барьер, что у серверного подтверждения (validateEditorVersions): если в
      // Composer сохранены новые правки, снимок плана устарел и добавлять его нельзя.
      // Иначе карточка показывала бы старый текст с активной кнопкой, которая всегда падает.
      const source =
        versionsKnown && Number(item?.draftId) > 0 && Number(item?.editorVersion) > 0 &&
        versions.get(Number(item.draftId)) !== Number(item.editorVersion)
          ? { ...item, editorVersion: undefined }
          : item;

      const evaluation = evaluateAutopilotItem(source, nowMs, { actor: "human" });
      const state = autopilotPlanItemState({ item: source, evaluation, planStatus });
      output.push({
        key: `plan-${planId}-${index}`,
        id: `plan-${planId}-${index}`,
        planId,
        planRevision: Number.isSafeInteger(planRevision) ? planRevision : 1,
        planStatus,
        index,
        channelId: Number.isSafeInteger(channelId) ? channelId : null,
        channelTitle: typeof plan?.channel_title === "string" ? plan.channel_title : null,
        scheduledAt: new Date(scheduledAt).toISOString(),
        topic: asText(item?.topic),
        text: sanitizeAutopilotPublicText(item?.draft),
        media: item?.media ?? null,
        formatting: Array.isArray(item?.formatting) ? item.formatting : [],
        state: state.state,
        statusLabel: state.statusLabel,
        issues: state.issues,
        selectable: Boolean(canPublish && state.selectable),
        editable: Boolean(canEdit && state.editable),
      });
    }
  }
  return output.sort((left, right) => Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt));
}
