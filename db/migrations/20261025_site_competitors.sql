begin;

-- Сравнение с конкурентами: аудит сайта до сих пор смотрел только внутрь себя.
-- Пользователь не мог увидеть, что у конкурентов есть страницы, разметка и объём,
-- которых нет у него, — а именно это превращает «список замечаний» в приоритеты.
--
-- Конкурентов добавляет человек: автоматически угадывать их по выдаче Аврора пока
-- не умеет (для этого нужны внешние поисковые источники). Обход идёт тем же
-- безопасным обходчиком, что и сайт, только по публичным страницам и с меньшим лимитом.
--
-- site_competitors — до трёх доменов на сайт, со снимком сравнения в summary.

create table if not exists site_competitors (
  id            bigint generated always as identity primary key,
  site_id       bigint not null references sites (id) on delete cascade,
  project_id    bigint not null references projects (id) on delete restrict,
  user_id       bigint not null references users (id) on delete cascade,
  domain        text not null,
  canonical_url text not null,
  status        text not null default 'pending'
                  check (status in ('pending', 'ready', 'error')),
  last_error    text,
  summary       jsonb,
  crawled_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint site_competitors_site_domain_uniq unique (site_id, domain),
  constraint site_competitors_domain_check check (
    length(domain) between 1 and 253 and domain !~ '[/?#@\s]'
  ),
  constraint site_competitors_canonical_url_check check (canonical_url ~ '^https?://'),
  constraint site_competitors_last_error_check check (last_error is null or length(last_error) <= 300)
);

create index if not exists site_competitors_site_idx
  on site_competitors (site_id, created_at desc);

commit;
