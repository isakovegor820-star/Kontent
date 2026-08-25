export type OpportunityPageStatus =
  | "loading"
  | "ready"
  | "no_channel"
  | "feature_disabled"
  | "access_denied"
  | "session_expired"
  | "initial_error";

export function classifyOpportunityFailure(
  status: number,
  error: string | undefined,
): Exclude<OpportunityPageStatus, "loading" | "ready"> {
  if (status === 401 || error === "unauthorized") return "session_expired";
  if (error === "channel_not_found") return "no_channel";
  if (error === "feature_disabled") return "feature_disabled";
  if (status === 403 || error === "access_denied") return "access_denied";
  return "initial_error";
}

export function opportunityActionError(error: string | undefined): string {
  if (error === "opportunity_stale") {
    return "Возможность устарела. Обновите карту и выберите актуальную тему.";
  }
  if (error === "opportunity_not_actionable") {
    return "Для этой возможности пока недостаточно подтверждённых данных.";
  }
  if (error === "opportunity_not_found") {
    return "Возможность больше недоступна. Обновите карту.";
  }
  if (error === "access_denied") return "У вас нет права создавать черновик в этом проекте.";
  return "Не удалось создать черновик. Повторите попытку.";
}
