begin;

-- The worker scans stale provider claims globally after startup and once per minute.
-- Keep that safety sweep bounded to the small set of active delivery leases.
create index if not exists bot_client_inquiries_stale_delivery_idx
  on bot_client_inquiries (provider_started_at, id)
  where status = 'approved';

commit;
