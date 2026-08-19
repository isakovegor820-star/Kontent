import { hasVerifiedQualityMetadata } from "./post-quality.mjs";
import { isAutopilotHumanReviewItem } from "./autopilot-review.mjs";

/**
 * Автопилот показывает план как готовый только когда каждый автоматический черновик
 * действительно сгенерирован и прошёл проверку. Старые смешанные планы из регрессии
 * остаются в БД для аудита, но в интерфейсе заменяются безопасным состоянием пересборки.
 */
export function autopilotPlanNeedsQualityRebuild(items) {
  return (Array.isArray(items) ? items : []).some(
    (item) =>
      item?.status === "pending" &&
      item?.qualityOrigin === "automatic" &&
      (
        item?.aiReady === false ||
        (
          !isAutopilotHumanReviewItem(item) &&
          (
            item?.qualityBlocked === true ||
            item?.quality?.passed !== true ||
            !hasVerifiedQualityMetadata(item?.quality)
          )
        )
      ),
  );
}
