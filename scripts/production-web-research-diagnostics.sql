-- Read-only probe for Aurora's internet research.
--
-- Answers three questions with evidence instead of guesses: did the scheduled research
-- actually run in production, did anything survive the trust gates, and did the verified
-- facts reach the channel-facing surfaces. Contains only SELECT statements; it starts
-- nothing, migrates nothing and writes nothing.

\pset pager off
\pset border 2

\echo '===== RUN COUNTS BY STATUS AND TRIGGER ====='
select trigger_kind, status, count(*) as runs,
       coalesce(sum(findings_count), 0) as findings,
       coalesce(sum(rejections_count), 0) as rejections
  from web_research_runs
 group by trigger_kind, status
 order by runs desc;

\echo '===== LAST 10 RUNS ====='
select id,
       trigger_kind,
       status,
       left(coalesce(topic, ''), 44) as topic,
       findings_count,
       rejections_count,
       coalesce(stats->>'queries', '0') as queries,
       coalesce(stats->>'pages', '0') as pages,
       coalesce(stats->>'candidates', '0') as candidates,
       coalesce(stats->>'spentMs', '0') as spent_ms,
       to_char(started_at, 'MM-DD HH24:MI') as started
  from web_research_runs
 order by started_at desc, id desc
 limit 10;

\echo '===== REJECTION CODES FROM THE LAST 5 RUNS ====='
select run.id,
       left(coalesce(rejection->>'code', 'unknown'), 34) as code,
       count(*) as times
  from web_research_runs run
  cross join lateral jsonb_array_elements(coalesce(run.stats->'rejections', '[]'::jsonb)) as rejection
 where run.id in (select id from web_research_runs order by started_at desc limit 5)
 group by run.id, code
 order by run.id desc, times desc
 limit 40;

\echo '===== VERIFIED FACTS BY KIND AND SOURCE TIER ====='
select kind, source_tier, count(*) as facts,
       count(distinct source_domain) as domains,
       min(published_at)::date as oldest,
       max(published_at)::date as newest
  from web_research_findings
 group by kind, source_tier
 order by facts desc;

\echo '===== LAST 8 VERIFIED FACTS ====='
select left(claim, 70) as claim,
       source_domain,
       source_tier,
       coalesce(legal_status, '-') as legal_status,
       to_char(published_at, 'YYYY-MM-DD') as published
  from web_research_findings
 order by retrieved_at desc, id desc
 limit 8;

\echo '===== DID FACTS REACH THE CHANNEL SURFACES? ====='
select count(*) as signals_with_web_facts,
       count(distinct raw_metadata->>'webResearchFingerprint') as distinct_findings,
       min(last_seen_at)::date as oldest,
       max(last_seen_at)::date as newest
  from market_signals
 where raw_metadata ? 'webResearchFingerprint';

\echo '===== OPPORTUNITY SNAPSHOTS BUILT FROM THOSE SIGNALS ====='
select count(*) as snapshots,
       count(distinct channel_id) as channels,
       max(observed_at)::date as newest
  from opportunity_snapshots snapshot
 where exists (
   select 1 from market_signals signal
    where signal.id::text = snapshot.evidence->>'sourceId'
      and signal.raw_metadata ? 'webResearchFingerprint'
 );

\echo '===== END OF PROBE ====='
