import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, expect, test } from 'vitest';

const url = new URL(process.env.SYSTEM_TEST_DATABASE_URL || 'postgresql://invalid/invalid');
if (url.hostname !== '127.0.0.1' || url.port !== '57641' || url.pathname !== '/aurora_system_release_test') throw new Error('isolated_diagnostics_database_required');
const pool = new pg.Pool({ connectionString: url.href, max: 1 });
afterAll(() => pool.end());

test('production SQL exports machine evidence without editorial text or arbitrary JSON metadata', async () => {
  const client = await pool.connect();
  await client.query('begin');
  try {
    const privateText = 'PRIVATE_EDITORIAL_FIXTURE do not export this customer content';
    const project = (await client.query("insert into projects(name,created_by_user_id) values('Privacy fixture',1) returning id")).rows[0].id;
    const channel = (await client.query("insert into channels(user_id,project_id,network,title,is_active,status) values(1,$1,'tg','Privacy fixture',false,'disconnected') returning id", [project])).rows[0].id;
    await client.query('insert into autopilot_settings(user_id,project_id,channel_id,quick_settings) values(1,$1,$2,$3)', [project, channel, JSON.stringify({ editorial: privateText })]);
    const plan = (await client.query(`insert into autopilot_plan(user_id,project_id,channel_id,week_start,status,rules,build_report,quick_settings,terminal_outcome)
      values(1,$1,$2,current_date,'pending',$3,$4,$4,'complete') returning id`, [project, channel, privateText, JSON.stringify({ customerContext: privateText })])).rows[0].id;
    const failed = (await client.query(`insert into autopilot_plan(user_id,project_id,channel_id,week_start,status,rules)
      values(1,$1,$2,current_date,'error','provider_error') returning id`, [project, channel])).rows[0].id;
    // Keep synthetic fixtures in this transaction and run the exact report SELECT.
    // The production script owns its separate repeatable-read/read-only transaction.
    const sql = (await readFile(new URL('../../scripts/production-autopilot-diagnostics.sql', import.meta.url), 'utf8'))
      .replace(/^\\.*$/gm, '').replace(/begin transaction isolation level repeatable read read only;/i, '').replace(/\bcommit;/i, '');
    const raw = String((await client.query(sql)).rows[0].jsonb_pretty);
    expect(raw).not.toContain(privateText);
    expect(raw).not.toContain('customerContext');
    const report = JSON.parse(raw);
    expect(report.recentPlans.find((row: { id: number }) => Number(row.id) === Number(plan))).toMatchObject({ status: 'pending', rules_code: null, meta: { terminal_outcome: 'complete' } });
    expect(report.recentPlans.find((row: { id: number }) => Number(row.id) === Number(failed))).toMatchObject({ status: 'error', rules_code: 'provider_error' });
    expect(report.autopilotSettings.find((row: { channel_id: number }) => Number(row.channel_id) === Number(channel))).toMatchObject({ quick_settings_configured: true });
  } finally { await client.query('rollback'); client.release(); }
});
