#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

export async function reportAiSpend({ databaseUrl, date, providerBilling = null }) {
  if (!databaseUrl || !/^\d{4}-\d{2}-\d{2}$/u.test(date || "")) throw new Error("Explicit --database-url and UTC --date YYYY-MM-DD are required");
  const pool = new pg.Pool({ connectionString: databaseUrl, application_name: "aurora-ai-spend-readonly", max: 1,
    options: "-c default_transaction_read_only=on -c statement_timeout=15000" });
  try {
    const rows = (await pool.query(`select budget_date::text as date, provider, model,
      count(*)::int as attempts, count(*) filter (where not usage_known)::int as unknown_usage_attempts,
      coalesce(sum(charged_microusd) filter (where usage_known),0)::text as known_microusd,
      sum(coalesce(charged_microusd,reserved_microusd))::text as accounted_microusd,
      sum(input_tokens) filter (where usage_known)::text as input_tokens,
      sum(output_tokens) filter (where usage_known)::text as output_tokens
      from ai_spend_attempts where budget_date=$1::date group by budget_date,provider,model order by provider,model`, [date])).rows;
    const billing = providerBilling === null ? [] : JSON.parse(await readFile(providerBilling,"utf8"));
    if (!Array.isArray(billing) || billing.some(row=>row.date !== date || typeof row.provider !== "string" || typeof row.model !== "string" || !/^\d+$/u.test(String(row.billedMicrousd)))) throw new Error("Invalid canonical provider billing export");
    const keys = billing.map(row=>`${row.provider}/${row.model}`);
    if(new Set(keys).size !== keys.length) throw new Error("Duplicate provider billing aggregate");
    const reconciliation = rows.map(row=> {
      const bill=billing.find(entry=>entry.provider===row.provider && entry.model===row.model);
      return { ...row, provider_billed_microusd: bill ? String(bill.billedMicrousd) : null,
        reconciliation: !bill ? "provider_billing_missing" : row.unknown_usage_attempts > 0 ? "unknown_attempts_require_review"
          : BigInt(bill.billedMicrousd) === BigInt(row.accounted_microusd) ? "aggregate_matches" : "mismatch_requires_review" };
    });
    for(const bill of billing) if(!rows.some(row=>row.provider===bill.provider && row.model===bill.model)) reconciliation.push({date,provider:bill.provider,model:bill.model,provider_billed_microusd:String(bill.billedMicrousd),reconciliation:"provider_charge_without_ledger"});
    return { date, currency:"USD", unit:"microUSD", readOnly:true, rows:reconciliation };
  } finally { await pool.end(); }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const options={};
  for(let i=2;i<process.argv.length;i+=2) {
    const key=process.argv[i];const value=process.argv[i+1];
    if(!["--database-url","--date","--provider-billing","--output"].includes(key) || !value) throw new Error("Usage: report-ai-spend.mjs --database-url URL --date YYYY-MM-DD [--provider-billing canonical.json] [--output report.json]");
    options[key.slice(2)]=value;
  }
  try {
    const report=await reportAiSpend({databaseUrl:options["database-url"],date:options.date,providerBilling:options["provider-billing"]});
    const output=`${JSON.stringify(report,null,2)}\n`;
    if(options.output) await writeFile(options.output,output,{mode:0o600}); else process.stdout.write(output);
  } catch(error) { process.stderr.write(`AI spend report failed: ${error.code || error.name || "Error"}\n`);process.exitCode=1; }
}
