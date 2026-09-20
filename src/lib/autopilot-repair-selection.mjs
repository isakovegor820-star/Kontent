import { autopilotRetryableItemIndexes } from "./autopilot-build-progress.mjs";
import { autopilotQualityRepairStrategy } from "./autopilot-quality.mjs";

const AUTOMATIC_STRATEGIES = new Set(["deterministic_format", "provider_retry", "rewrite"]);

/** Pick actionable failed candidates, not the most frequent failure in the entire reserve. */
export function selectAutopilotRepairs(items, { count, scopeIndexes = null, retriedIndexes = [] } = {}) {
  const byIndex = new Map(items.map((item, index) => [
    Number.isSafeInteger(Number(item?.i)) ? Number(item.i) : index, item,
  ]));
  const scope = scopeIndexes == null ? null : new Set(scopeIndexes);
  const retried = new Set(retriedIndexes);
  const candidates = autopilotRetryableItemIndexes(items)
    .filter((index) => !scope || scope.has(index))
    .map((index) => {
      const item = byIndex.get(index);
      const strategy = item?.buildState === "waiting_provider" || !item?.quality
        ? "provider_retry"
        : autopilotQualityRepairStrategy(item.quality);
      return { index, item, strategy };
    })
    .filter(({ strategy }) => AUTOMATIC_STRATEGIES.has(strategy))
    .sort((left, right) =>
      Number(Boolean(right.item?.news)) - Number(Boolean(left.item?.news)) ||
      Number(retried.has(left.index)) - Number(retried.has(right.index)) ||
      left.index - right.index,
    )
    .slice(0, Math.max(0, Math.floor(Number(count) || 0)));
  return { indexes: candidates.map(({ index }) => index), strategy: candidates[0]?.strategy ?? null };
}
