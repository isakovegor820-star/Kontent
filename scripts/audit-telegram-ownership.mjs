import { Pool } from "pg";

const connectionString = process.env.TELEGRAM_OWNERSHIP_AUDIT_DATABASE_URL;
if (!connectionString) throw new Error("TELEGRAM_OWNERSHIP_AUDIT_DATABASE_URL must be explicitly supplied; no .env is loaded");
const pool = new Pool({ connectionString, max: 1, application_name: "aurora_telegram_ownership_readonly" });
try {
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    await client.query("set local statement_timeout = '10s'");
    const result = await client.query(`
      select channel.id as channel_id, channel.project_id, channel.user_id as historical_connector_user_id,
             channel.status, channel.is_active,
             exists(select 1 from project_members member where member.project_id = channel.project_id
               and member.user_id = channel.user_id and member.status = 'active' and member.role = 'owner') as connector_is_current_owner,
             proof.user_id as verified_user_id, proof.actor_id as verified_telegram_actor_id,
             proof.used_at as ownership_verified_at
        from channels channel
        left join lateral (
          select user_id, actor_id, used_at from telegram_channel_connection_proofs
           where project_id = channel.project_id and chat_id = channel.tg_chat_id and used_at is not null
           order by used_at desc limit 1
        ) proof on true
       where channel.network = 'tg' order by channel.project_id, channel.id
    `);
    await client.query("commit");
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), readOnly: true,
      limitation: "Recorded verification is historical evidence; Telegram permissions can change. Missing proof does not prove illegitimate ownership.",
      channels: result.rows.map((row) => ({ ...row, review: row.ownership_verified_at ? "proof_recorded" : "owner_confirmation_required" })),
    }, null, 2));
  } finally { client.release(); }
} finally { await pool.end(); }
