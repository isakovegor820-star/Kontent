export class AutopilotProjectScopeError extends Error {
  constructor(code) {
    super(`autopilot-plan: ${code}`);
    this.name = "AutopilotProjectScopeError";
    this.code = code;
  }
}

const positiveInteger = (value, code) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new AutopilotProjectScopeError(code);
  return number;
};

/**
 * Resolves an immutable async-job identity. The selected project is deliberately never
 * consulted: a later UI switch cannot move a queued Autopilot build into another project.
 */
export async function requireAutopilotPlanJobScope(db, data) {
  const planId = positiveInteger(data?.planId, "bad_plan_id");
  const projectId = positiveInteger(data?.projectId, "bad_project_id");
  const userId = positiveInteger(data?.userId, "bad_user_id");
  const channelId = positiveInteger(data?.channelId, "bad_channel_id");
  const result = await db.query(
    `select plan.id
       from autopilot_plan plan
       join channels channel
         on channel.id = plan.channel_id and channel.project_id = plan.project_id
        and channel.network = 'tg' and channel.is_active = true
       join autopilot_settings settings
         on settings.channel_id = plan.channel_id and settings.project_id = plan.project_id
       join content_brief brief
         on brief.channel_id = plan.channel_id and brief.project_id = plan.project_id
        and brief.ready = true
       join project_members member
         on member.project_id = plan.project_id and member.user_id = $3
        and member.status = 'active' and member.role in ('owner','author','approver')
      where plan.id = $1 and plan.project_id = $2 and plan.channel_id = $4
        and plan.status = 'building'`,
    [planId, projectId, userId, channelId],
  );
  if (!result.rowCount) throw new AutopilotProjectScopeError("project_identity_mismatch");
  return { planId, projectId, userId, channelId };
}
