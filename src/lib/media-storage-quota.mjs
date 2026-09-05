export function mediaStorageError(error) {
  const message = String(error?.message || "");
  if (message.startsWith("media_storage_quota_exceeded:")) return { code: "media_storage_quota_exceeded", status: 409 };
  if (message === "media_storage_limits_not_configured" || message === "media_storage_usage_inconsistent") return { code: "media_storage_unavailable", status: 503 };
  return null;
}

export function mediaStorageErrorLabel(code) {
  if (code === "media_storage_quota_exceeded") return "Место для медиа закончилось. Обратитесь к владельцу проекта, чтобы освободить место или изменить лимит.";
  if (code === "media_storage_unavailable") return "Хранилище медиа пока недоступно. Обратитесь к поддержке.";
  return null;
}

export function parseMediaStorageLimits(input) {
  const policy = { userMaxBytes: Number(input.userMaxBytes), projectMaxBytes: Number(input.projectMaxBytes), globalMaxBytes: Number(input.globalMaxBytes) };
  if (!Object.values(policy).every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("explicit_positive_media_storage_limits_required");
  return policy;
}

export async function configureMediaStorageLimits(pool, input, { apply = false } = {}) {
  const policy = parseMediaStorageLimits(input);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(8734921)");
    // Serialize first configuration too, when the singleton does not exist yet.
    // Lock the single policy before inspecting usage; the trigger takes a shared lock
    // on this same row, so configuration cannot race quota acquisition.
    await client.query("select id from media_storage_policy where id=1 for update");
    const usage = (await client.query("select scope,max(bytes_used)::text as maximum from media_storage_usage group by scope order by scope")).rows;
    const names = { user: "userMaxBytes", project: "projectMaxBytes", global: "globalMaxBytes" };
    const exceeded = usage.filter((row) => Number(row.maximum) > policy[names[row.scope]]).map((row) => row.scope);
    if (apply && exceeded.length) throw new Error("media_storage_policy_below_existing_usage");
    if (apply) await client.query(
      "insert into media_storage_policy(id,user_max_bytes,project_max_bytes,global_max_bytes) values(1,$1,$2,$3) on conflict(id) do update set user_max_bytes=$1,project_max_bytes=$2,global_max_bytes=$3,updated_at=now()",
      [policy.userMaxBytes,policy.projectMaxBytes,policy.globalMaxBytes],
    );
    await client.query(apply ? "commit" : "rollback");
    return { mode: apply ? "apply" : "dry_run", policy, usage, exceedsProposedLimit: exceeded };
  } catch (error) { await client.query("rollback").catch(() => {}); throw error; }
  finally { client.release(); }
}
