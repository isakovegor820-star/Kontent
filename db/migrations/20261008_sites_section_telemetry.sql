begin;

-- «Мои сайты» становится отдельным разделом навигации (sectionId = 'sites'); телеметрия
-- продукта проверяет section_id check-ограничением, поэтому список расширяется здесь.
alter table product_events drop constraint if exists product_events_section_check;
alter table product_events add constraint product_events_section_check check (
  section_id in (
    'today','calendar','studio','autopilot','composer','library','rss','knowledge',
    'recon','opportunities','radar','siteAnalysis','sites','growth','analytics','settings'
  )
);

alter table product_event_daily drop constraint if exists product_event_daily_section_check;
alter table product_event_daily add constraint product_event_daily_section_check check (
  section_id in (
    'today','calendar','studio','autopilot','composer','library','rss','knowledge',
    'recon','opportunities','radar','siteAnalysis','sites','growth','analytics','settings'
  )
);

commit;
