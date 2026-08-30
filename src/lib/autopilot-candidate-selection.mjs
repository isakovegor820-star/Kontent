import { findAutopilotNearDuplicate } from "./autopilot-config.mjs";

/** The reserve grows proportionally while the publication target stays unchanged. */
export function autopilotCandidateCount(publicationCount) {
  const target = Math.max(1, Math.round(Number(publicationCount) || 1));
  return target + Math.max(1, Math.ceil(target * 0.4));
}

function compareCandidates(left, right) {
  const score = Number(right?.quality?.score ?? right?.qualityScore ?? 0) -
    Number(left?.quality?.score ?? left?.qualityScore ?? 0);
  if (score) return score;
  const evidence = Number(Boolean(right?.sourceConfirmed)) - Number(Boolean(left?.sourceConfirmed));
  if (evidence) return evidence;
  return Number(left?.i ?? 0) - Number(right?.i ?? 0);
}

export function selectAutopilotCandidates(candidates, { targetCount, newsQuota = 0 } = {}) {
  const target = Math.max(0, Math.round(Number(targetCount) || 0));
  const quota = Math.min(target, Math.max(0, Math.round(Number(newsQuota) || 0)));
  const ranked = [...(Array.isArray(candidates) ? candidates : [])].sort(compareCandidates);
  const selected = [];
  const picked = new Set();

  const takeDiverse = (pool, limit) => {
    for (const candidate of pool) {
      if (selected.length >= target || limit <= 0 || picked.has(candidate)) continue;
      if (findAutopilotNearDuplicate(candidate, selected)) continue;
      selected.push(candidate);
      picked.add(candidate);
      limit -= 1;
    }
  };

  takeDiverse(ranked.filter((candidate) => Boolean(candidate?.news)), quota);
  takeDiverse(ranked, target - selected.length);

  return {
    selected,
    reserve: ranked.filter((candidate) => !picked.has(candidate)),
    targetCount: target,
    candidateCount: ranked.length,
    newsQuota: quota,
    selectedNewsCount: selected.filter((candidate) => Boolean(candidate?.news)).length,
    newsQuotaSatisfied: selected.filter((candidate) => Boolean(candidate?.news)).length >= quota,
    // News is a composition goal, not a hard delivery gate. A full evergreen set is usable.
    complete: selected.length === target,
  };
}
