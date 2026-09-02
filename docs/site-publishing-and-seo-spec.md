# Сайт как площадка: публикация материалов, профиль сайта и отчёт SEO/GEO/AEO

Дата проектирования: 2 сентября 2026 года.
Статус: продуктовые решения согласованы; этап 1 (сайт, профиль, стартовый аудит, `/app/sites`) реализован в миграции `20261006_sites_and_site_profiles.sql`, `src/lib/site-profile/`, `src/lib/site-report/`, `src/lib/sites/`, `worker/site-profile-persistence.mjs`. Этапы 2–5 — в плане.

## 1. Цель

Научить Аврору работать с сайтом клиента так же, как она работает с Telegram и VK:

1. изучать сайт и держать по нему внутреннюю базу знаний — какие страницы есть, какие темы закрыты, какие вопросы аудитории остались без ответа;
2. готовить и публиковать на сайт материалы разных типов — не только пересказ новостей, а познавательные разборы, ответы на вопросы, гиды и кейсы с перелинковкой на существующие страницы;
3. оценивать видимость сайта в классическом поиске (SEO), в генеративных ответах (GEO) и в блоках быстрых ответов (AEO) и объяснять причины простым языком: «по вашему бренду в ответах ИИ пусто, потому что о вас нет внешних упоминаний и структурированных данных»;
4. выдавать отчёт с динамикой и сохранять его в файл.

Аврора не обещает рост трафика и позиций. Она показывает, что изменилось в измеримых вещах: сколько тем закрыто, появились ли упоминания, исправлены ли технические проблемы.

## 2. Что уже есть в приложении и переиспользуется

| Модуль | Что даёт новой функции | Где |
|---|---|---|
| Анализ сайта | безопасный crawl (robots, sitemap, SSRF), страницы, источники, доказательства, сущности, ответы на вопросы реестра, рекомендации, экспорт в PDF/HTML/Markdown/JSON/CSV/XLSX | `src/lib/site-crawler.mjs`, `worker/site-analysis-worker.mjs`, таблицы `site_analysis_*`, `src/lib/site-analysis/export.mjs` |
| База знаний | `knowledge_sources` / `knowledge_chunks` с pgvector (bge-m3, 1024) и гибридным поиском RRF | `db/schema.sql`, `src/lib/knowledge-index-queue.mjs` |
| Автопилот | бриф, план, генерация, оценка качества, рерайт, режим `confirm` / полный | очередь `autopilot-plans`, `src/lib/autopilot-*.mjs`, `src/lib/post-quality.mjs` |
| RSS | источники материалов с дедупликацией по `(feed_id, guid)` и релевантностью | `worker/rss-pipeline.mjs`, `rss_feeds`, `rss_items` |
| Публикация | `drafts` → `draft_destinations` → `publication_operations` → `posts`, идемпотентность, outbox, reconcile | `src/lib/social-provider-contract.mjs`, `src/lib/provider-capabilities.mjs` |
| Вопросы аудитории | накопленный спрос из комментариев и обращений | `audience_questions`, `audience_question_occurrences` |
| Экспорт | pdfkit, CSV/XLSX, артефакты в Postgres с токеном скачивания | `src/lib/project-export.mjs`, очередь `project-export` |

Чего нет: сайта как назначения публикации, профиля сайта как долгоживущей сущности (сейчас `site_analysis_jobs` — это одноразовый прогон), зонда видимости в ИИ-ответах, отчёта с динамикой между прогонами.

## 3. Принятые продуктовые решения

Зафиксированы в обсуждении 2 сентября 2026 года.

1. **Куда публикуем.** Два пути: нативный адаптер WordPress (REST API) и хостируемый раздел `news.<домен клиента>` (или подпапка через reverse-proxy правило на стороне клиента), страницы которого генерирует и отдаёт Аврора. Виджет и JSON-фид не делаем: JS-виджет не индексируется и противоречит цели SEO. Адаптеры под Tilda/Bitrix — только после подтверждённого спроса.
2. **Режим автоматичности.** По умолчанию `confirm`: каждый материал подтверждает человек. Полный автомат включается пользователем и только после N подряд одобренных без правок материалов (стартовое значение N = 10, хранится в настройках сайта).
3. **Один источник — один материал.** Аврора не публикует «новость» и «разбор» по одному событию одновременно. Тип материала выбирается правилом по профилю сайта (раздел 6).
4. **Ответственность за содержание.** Для каждой опубликованной страницы ведётся журнал: кто одобрил, какая версия текста, какие источники и доказательства использованы. Переиспользуется модель `site_analysis_sources` / `site_analysis_evidence`.
5. **Отчёт сохраняется в файл.** PDF для клиента, Markdown — в базу знаний сайта, чтобы следующий отчёт сравнивался с предыдущим и отмечал выполненные и невыполненные рекомендации.
6. **Честность в SEO.** Позиции в выдаче и реальный трафик Аврора не считает без интеграций (Яндекс.Вебмастер, Google Search Console, Метрика). Без них отчёт содержит on-page проверки, инвентарь тем и зонд GEO/AEO собственными движками, и явно указывает `required_integration` там, где данных нет.

## 4. Сущности и схема PostgreSQL

Все новые таблицы привязаны к `projects` (границы рабочего пространства, см. `docs/adr/0001-workspace-boundary-and-rbac.md`).

### 4.1. `sites` — сайт как долгоживущая сущность

```sql
create table if not exists sites (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete restrict,
  user_id            bigint not null references users (id) on delete cascade,
  confirmed_domain   text not null,
  canonical_url      text not null,
  verification_state text not null default 'unverified'
    check (verification_state in ('unverified','dns_txt_pending','meta_tag_pending','verified','revoked')),
  verification_token text not null,
  verified_at        timestamptz,
  latest_profile_id  bigint,   -- fk на site_profiles добавляется после её создания
  publishing_mode    text not null default 'confirm'
    check (publishing_mode in ('confirm','auto')),
  auto_unlock_streak integer not null default 10 check (auto_unlock_streak > 0),
  approved_streak    integer not null default 0 check (approved_streak >= 0),
  cadence            jsonb not null default '{}'::jsonb check (jsonb_typeof(cadence) = 'object'),
  status             text not null default 'active'
    check (status in ('active','paused','disconnected')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint sites_project_domain_uniq unique (project_id, confirmed_domain)
);
```

Владение сайтом подтверждается DNS TXT или meta-тегом до первой публикации. Без `verified` публикация и внешний зонд по домену недоступны — то же правило, что для каналов Telegram («один канал — один аккаунт»).

### 4.2. `site_destinations` — куда физически публикуем

```sql
create table if not exists site_destinations (
  id            bigint generated always as identity primary key,
  site_id       bigint not null references sites (id) on delete cascade,
  kind          text not null check (kind in ('wordpress','hosted_section')),
  base_url      text not null,          -- WP: https://site.ru/wp-json ; hosted: https://news.site.ru
  credentials   text,                   -- AES-GCM-конверт (src/lib/token-crypto.mjs), никогда plaintext
  credential_state text not null default 'not_configured',
  section_path  text,                   -- WP: категория/раздел; hosted: префикс пути
  settings      jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  status        text not null default 'active'
    check (status in ('active','needs_reconnect','revoked','disconnected')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint site_destinations_site_kind_uniq unique (site_id, kind)
);
```

Для `hosted_section` дополнительно: `custom_domain`, состояние выпуска TLS, дата последней проверки CNAME — в `settings` до тех пор, пока не станет ясно, что нужны отдельные колонки.

### 4.3. `site_profiles` — профиль сайта (то, что Аврора «знает» о сайте)

Одна строка на успешный прогон профилирования. `sites.latest_profile_id` указывает на актуальный.

```sql
create table if not exists site_profiles (
  id                bigint generated always as identity primary key,
  site_id           bigint not null references sites (id) on delete cascade,
  analysis_job_id   bigint references site_analysis_jobs (id) on delete set null,
  profile_version   text not null default 'site-profile-v1',
  page_count        integer not null default 0,
  publication_count integer not null default 0,     -- страниц, распознанных как статьи/новости
  topics            jsonb not null default '[]'::jsonb,  -- [{key,label,page_keys[],coverage:'strong'|'thin'|'missing'}]
  gaps              jsonb not null default '[]'::jsonb,  -- темы и вопросы без страниц-ответов
  technical         jsonb not null default '{}'::jsonb,  -- сводка on-page: title/description/h1/canonical/schema/дубли/скорость
  linkable_pages    jsonb not null default '[]'::jsonb,  -- услуги, контакты, кейсы — цели перелинковки
  summary           text,
  created_at        timestamptz not null default now()
);
```

Инвентарь страниц не дублируется: он остаётся в `site_analysis_pages` привязанного прогона. Профиль — это выводы поверх инвентаря.

### 4.4. База знаний сайта

`knowledge_sources` и `knowledge_chunks` сейчас привязаны к `channel_id not null`. Расширение:

- добавить `site_id bigint references sites (id) on delete cascade` и ослабить `channel_id` до nullable с check-ограничением «ровно один из `channel_id` / `site_id` заполнен»;
- новые `kind` источника: `site_page` (текст страницы сайта), `site_publication` (материал, опубликованный Авророй), `site_report` (Markdown прошлого отчёта);
- индекс `knowledge_chunks (site_id, kind)`.

Именно эта база даёт: проверку на смысловой дубль перед публикацией, перелинковку на свои страницы и память о прошлых рекомендациях.

### 4.5. `site_articles` — материалы для сайта

Материал живёт отдельно от `drafts`: у него есть заголовок, slug, тип, SEO-поля и HTML-тело, которых у поста для соцсети нет. При этом он проходит тот же цикл подтверждения и публикации через `publication_operations`.

```sql
create table if not exists site_articles (
  id                bigint generated always as identity primary key,
  site_id           bigint not null references sites (id) on delete cascade,
  user_id           bigint not null references users (id) on delete cascade,
  article_type      text not null check (article_type in (
                      'company_news','industry_explainer','audience_answer',
                      'evergreen_guide','case_study','machine_readable_page')),
  origin            text not null check (origin in ('rss','channel_post','audience_question','gap','manual')),
  source_ref        jsonb,                              -- {rss_item_id | post_id | audience_question_id | gap_key}
  title             text not null,
  slug              text not null,
  meta_description  text,
  body_markdown     text not null,
  body_html         text,
  internal_links    jsonb not null default '[]'::jsonb, -- [{url, anchor, reason}]
  structured_data   jsonb,                              -- schema.org JSON-LD
  evidence_keys     jsonb not null default '[]'::jsonb,
  similarity_check  jsonb,                              -- {max_score, nearest_url, verdict}
  quality           jsonb,                              -- результат post-quality
  version           bigint not null default 1 check (version > 0),
  status            text not null default 'draft'
    check (status in ('draft','needs_review','approved','scheduled','publishing','published','failed','rejected','retired')),
  approved_by       bigint references users (id) on delete set null,
  approved_version  bigint,
  approved_at       timestamptz,
  published_url     text,
  provider_ref      jsonb,                              -- WP post id / hosted page id
  scheduled_at      timestamptz,
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint site_articles_site_slug_uniq unique (site_id, slug)
);
```

Правило `one source — one article` закрепляется уникальным индексом по `(site_id, origin, source_ref)` для `origin in ('rss','channel_post','audience_question')`.

Ревизии текста — по образцу `draft_revisions`: таблица `site_article_revisions (article_id, version, body_markdown, changed_by, change_kind)`. Журнал одобрений хранится в ней и в `audit_events`.

### 4.6. `site_visibility_probes` — зонд GEO/AEO

```sql
create table if not exists site_visibility_probes (
  id             bigint generated always as identity primary key,
  site_id        bigint not null references sites (id) on delete cascade,
  run_key        text not null,                        -- один прогон = набор вопросов × движков
  question_key   text not null,                        -- из site_profiles.gaps / реестра ниши
  question_text  text not null,
  engine         text not null,                        -- id движка из src/lib/engines.ts
  brand_mentioned boolean not null,
  site_cited     boolean not null,
  competitors_mentioned jsonb not null default '[]'::jsonb,
  answer_excerpt text,                                 -- обрезанный, без инструкций
  checked_at     timestamptz not null default now(),
  constraint site_visibility_probes_run_uniq unique (site_id, run_key, question_key, engine)
);
```

Зонд не претендует на то, чтобы быть замером реальной выдачи Perplexity или Яндекс-Нейро. Это воспроизводимый опрос подключённых движков одними и теми же вопросами; ценность — в динамике между прогонами и в списке конкурентов, которых движки называют вместо клиента.

### 4.7. `site_reports` — отчёты

```sql
create table if not exists site_reports (
  id               bigint generated always as identity primary key,
  site_id          bigint not null references sites (id) on delete cascade,
  kind             text not null check (kind in ('initial_audit','monthly','on_demand')),
  period_start     timestamptz,
  period_end       timestamptz,
  profile_id       bigint references site_profiles (id) on delete set null,
  previous_report_id bigint references site_reports (id) on delete set null,
  probe_run_key    text,
  payload          jsonb not null,                     -- структурированный отчёт, источник истины
  summary_ru       text not null,                      -- человеческие формулировки
  status           text not null default 'generating'
    check (status in ('generating','ready','failed')),
  created_at       timestamptz not null default now()
);
```

Файлы отчёта не хранятся в этой таблице: экспорт рендерится из `payload` через существующий путь `project_export_artifacts` (раздел 9).

## 5. Контракт назначения «сайт»

### 5.1. Реестр возможностей

В `src/lib/provider-capabilities.mjs` добавляются два провайдера с `role: "destination"`:

| id | connection.kind | livePublish | analytics | mediaTypes | limits.authority |
|---|---|---|---|---|---|
| `wordpress` | `application_password` | supported (credentials + permissions) | unsupported до интеграции GSC/Метрики | text, image | provider (WP REST) |
| `site_hosted` | `domain_verification` | supported (permissions = домен подтверждён) | supported (собственные логи отдачи страниц) | text, image | product |

`exportPackage` для обоих — supported: пользователь без CMS-доступа получает HTML + JSON-LD + изображения пакетом.

Расширяется `PROVIDER_MEDIA_TYPES`? Нет: статья описывается новым полем `payloadKinds: ["post", "article"]` у провайдера, а `tg`/`vk` получают `["post"]`. Композитор проверяет совместимость draft ↔ destination по этому полю и не даёт отправить статью в Telegram как есть.

### 5.2. Адаптер

Адаптер сайта реализует тот же fail-closed контракт, что и будущие соцсети (`assertFutureProviderAdapter`), пока не пройдёт контрактные тесты:

```ts
type SiteArticlePayload = {
  articleId: number;
  version: number;
  title: string;
  slug: string;
  metaDescription: string | null;
  bodyHtml: string;
  structuredData: object | null;
  canonicalUrl: string | null;
  media: Array<{ assetId: number; role: "cover" | "inline"; alt: string }>;
  publishAt: string; // ISO
};

type SiteDestinationAdapter = {
  id: "wordpress" | "site_hosted";
  composerSupported: boolean;             // false до контрактных тестов
  retryPolicy: "reconcile_before_retry";
  verify(destination): Promise<{ ok: boolean; credentialState; permissionState; reason? }>;
  publish(destination, payload, { idempotencyKey }): Promise<ProviderDeliveryResult>;
  reconcile(destination, providerOperationId): Promise<ProviderDeliveryResult>;
  update(destination, providerRef, payload): Promise<ProviderDeliveryResult>;
  unpublish(destination, providerRef): Promise<ProviderDeliveryResult>;
};
```

`ProviderDeliveryResult` — существующие `success` / `definite_failure` / `delivery_unknown` / `rate_limited` / `auth_failed` из `social-provider-contract.mjs`. Для WordPress `providerOperationId` = `slug`, а reconcile — `GET /wp/v2/posts?slug=`: это гарантирует, что при обрыве сети статья не выйдет дважды.

`update` и `unpublish` нужны сайту в отличие от Telegram: статью правят после публикации и снимают, если факты устарели (`valid_until` в базе знаний).

### 5.3. Хостируемый раздел

- Отдельный Next.js route group `app/(hosted)/[siteId]/...`, резолв сайта по заголовку `Host` через таблицу `site_destinations.settings.custom_domain`.
- Страницы рендерятся сервером из `site_articles` со статусом `published`; на них — canonical, Open Graph, JSON-LD `Article`/`FAQPage`/`Organization`, ссылка «на основной сайт».
- `robots.txt` и `sitemap.xml` генерируются автоматически; `sitemap.xml` раздела клиент может добавить в Вебмастер/GSC — это и есть путь к настоящим данным видимости.
- TLS: по образцу того, как выдаются сертификаты для основного домена продукта; до автоматизации — ручная выдача с фиксацией в `settings`. Требование к деплою фиксируется в `docs/` отдельно перед этапом 2.
- Отдача страниц пишет минимальный лог (путь, дата, referer без query) в `product_events` — это единственная собственная «аналитика» хостируемого раздела.

## 6. Типы материалов и правило выбора

| `article_type` | Источник (`origin`) | Когда выбирается | Что обязательно внутри |
|---|---|---|---|
| `company_news` | `channel_post` | пост в TG/VK клиента с признаком события (дата, «открыли», «запустили», «провели») | факт, дата, 1 ссылка на страницу услуги |
| `industry_explainer` | `rss` | новость отрасли прошла релевантность RSS **и** в профиле сайта есть тема, к которой она относится | блок «что это значит для наших клиентов», ссылка на тему сайта, источник новости |
| `audience_answer` | `audience_question` / `gap` | вопрос с частотой ≥ 2 или пробел профиля с меткой `question` | прямой ответ в первом абзаце (≤ 60 слов), затем развёртка, JSON-LD `FAQPage` |
| `evergreen_guide` | `gap` | тема с coverage = `missing`, ключевая для ниши | структура H2/H3 по подвопросам, перелинковка на ≥ 2 страницы сайта |
| `case_study` | `channel_post` с медиа | серия постов об одной работе | до/после, что делали, ссылка на услугу |
| `machine_readable_page` | `gap` (технический) | нет `Organization`/`LocalBusiness`/`FAQPage` на сайте | только структурированные данные и краткий текст; обновляется, а не множится |

Правила поверх типов:

1. **Ритм задаёт профиль, не лента.** `sites.cadence` хранит недельные квоты по типам; стартовые значения для малого бизнеса: 1 `audience_answer`, 1 из {`evergreen_guide`, `industry_explainer`}, `company_news` — только по факту события. RSS не может превысить квоту `industry_explainer`.
2. **Проверка дубля по смыслу.** Перед `needs_review` считается косинусная близость к чанкам `kind in ('site_page','site_publication')`. Порог отказа 0.86, порог предупреждения 0.78; значения уточняются на фикстурах этапа 0. Результат в `similarity_check`, при отказе — статус `rejected` с причиной `semantic_duplicate` и ссылкой на ближайшую страницу.
3. **Перелинковка обязательна.** Минимум одна ссылка на `linkable_pages`; движку передаётся список допустимых URL, ссылки вне списка вырезаются валидатором.
4. **Никаких выдуманных фактов о клиенте.** Факты о компании берутся только из `knowledge_chunks` сайта и канала; правило и промпт наследуются от «доказательного стандарта» в `docs/site-analysis-osint-interview-spec.md`.
5. **Качество.** Существующий `post-quality` расширяется профилем `article`: проверка длины первого ответа для `audience_answer`, наличия H2, отсутствия «водных» вводных, наличия источника у `industry_explainer`.

## 7. Конвейер материала

```
источник (rss_item | post | audience_question | gap)
  → выбор типа по правилу 6 (worker, очередь site-articles)
  → сбор контекста: профиль, linkable_pages, findSupport по базе знаний сайта
  → генерация (engines.ts) → валидатор ссылок и фактов → post-quality(article)
  → similarity_check → needs_review | rejected
  → одобрение (UI или бот; approved_streak++ / сброс при правке)
  → publication_operation(destination = site_destination) → адаптер.publish
  → reconcile → published; индексирование в базу знаний как site_publication
```

Новая очередь BullMQ: `site-articles` (генерация и проверки). Публикация идёт через существующую `publish`, чтобы сохранить одну точку идемпотентности и outbox. Профилирование сайта — через существующую `site-analysis` с новым `coverage_mode = 'profile'`. Зонд и отчёты — очередь `site-reports`.

Крон: профиль пересобирается раз в 14 дней и после каждых 5 публикаций; зонд — раз в 30 дней; отчёт `monthly` — в первый рабочий день месяца.

## 8. Отчёт SEO / GEO / AEO

### 8.1. Состав `payload`

```json
{
  "report_version": "site-report-v1",
  "site": { "domain": "example.ru", "verified": true },
  "period": { "start": "...", "end": "..." },
  "seo": {
    "onpage": { "pages_checked": 84, "issues": [{ "code": "missing_meta_description", "count": 31, "sample_urls": [] }] },
    "topics": { "strong": 6, "thin": 4, "missing": 9, "closed_this_period": 3 },
    "required_integrations": ["yandex_webmaster", "google_search_console"]
  },
  "geo": {
    "probe_run_key": "...",
    "questions": 12,
    "brand_mentioned": 1,
    "site_cited": 0,
    "competitors_top": [{ "name": "...", "mentions": 7 }],
    "delta_vs_previous": { "brand_mentioned": "+1", "site_cited": "0" }
  },
  "aeo": {
    "answer_pages": 4,
    "faq_schema_pages": 2,
    "questions_without_page": 9
  },
  "publications": { "published": 6, "by_type": { "audience_answer": 3, "evergreen_guide": 1, "company_news": 2 }, "rejected_duplicates": 1 },
  "recommendations": [
    { "key": "add_organization_schema", "status": "done" },
    { "key": "answer_question:стоимость-имплантации", "status": "open", "since_report_id": 12 }
  ],
  "limitations": ["Позиции и трафик не измерялись: интеграции не подключены."]
}
```

### 8.2. Человеческие формулировки

`summary_ru` формируется по шаблонам от данных, а не свободной генерацией, чтобы отчёт не обещал лишнего. Примеры:

- GEO, `brand_mentioned = 0`: «В ответах ИИ-движков на 12 вопросов вашей ниши ваш бренд не упомянут ни разу. Движки называют: A (7), B (4). Основная причина по данным сайта: нет внешних упоминаний и нет структурированных данных об организации.»
- AEO, `questions_without_page = 9`: «9 вопросов, которые задаёт ваша аудитория, не имеют страницы-ответа на сайте. За период опубликовано 3 ответа.»
- Динамика: «Из 5 рекомендаций прошлого отчёта выполнены 2.»

Причина в формулировке берётся только из фактов профиля (`technical`, `gaps`) — правило «отсутствие данных ≠ отрицательный факт» сохраняется.

## 9. Экспорт отчёта в файл

- `GET /api/sites/[id]/reports/[reportId]/export?format=pdf|markdown|html|json` — синхронный рендер по образцу `src/lib/site-analysis/export.mjs`; PDF через pdfkit.
- Для тяжёлых отчётов (архив за год, все зонды) — постановка в `project-export` с новым `PROJECT_EXPORT_FORMATS`-типом `site_report`, артефакт в `project_export_artifacts`, скачивание по токену.
- Markdown-версия после готовности отчёта автоматически добавляется в базу знаний сайта как `knowledge_sources.kind = 'site_report'` — так следующий отчёт видит прошлые рекомендации.
- В UI сайта — вкладка «Отчёты» со списком, сравнением с предыдущим и кнопками скачивания.

## 10. Безопасность и границы

1. Учётные данные WordPress — только в AES-GCM-конверте (`src/lib/token-crypto.mjs`); в логах и экспортах — никогда.
2. Публикация возможна только при `sites.verification_state = 'verified'` и активном членстве пользователя в проекте с ролью, разрешающей публикацию (RBAC из ADR-0001).
3. Хостируемый раздел отдаёт только `published` статьи подтверждённых сайтов; неизвестный `Host` → 404 без раскрытия существования сайта.
4. Тексты страниц клиента и ответы движков — недоверенные данные: в промпты попадают структурно, с обрезкой, с признаком `injection_signal` из существующего пайплайна.
5. Зонд не отправляет движкам ничего, кроме вопроса ниши и названия бренда; никаких внутренних данных клиента.
6. Все действия «одобрил / отклонил / снял с публикации» — в `audit_events`.

## 11. План разработки

### Этап 0. Фикстуры и базовая линия
1. Фикстуры сайтов: WordPress с REST, сайт без блога, сайт с тонкими дублями, сайт без schema.org.
2. Набор из 30 пар текстов для калибровки порогов `similarity_check`.
3. Контрактный тест-заглушка для `SiteDestinationAdapter` (fail-closed).

### Этап 1. Сайт и профиль
1. Миграция: `sites`, `site_profiles`, `site_reports`, `site_analysis_jobs.site_id`.
2. Детерминированный построитель профиля поверх `site_analysis_pages` / `site_analysis_sources`: классификация страниц, темы, пробелы, `linkable_pages`, `technical`.
3. Worker: для job с `site_id` после `saving` — запись профиля и отчёта `initial_audit`.
4. API `/api/sites` (создать, подтвердить домен, карточка, экспорт отчёта), UI `/app/sites`.
5. Экспорт `initial_audit` в PDF/Markdown/HTML/JSON — первый видимый результат для пользователя.

Индексация страниц сайта в базу знаний перенесена на этап 3 (решение 13.5).

### Этап 2. Назначение «сайт»
1. `site_destinations`, провайдеры `wordpress` и `site_hosted` в реестре возможностей, `payloadKinds`.
2. Адаптер WordPress: verify / publish / reconcile / update / unpublish, контрактные тесты на фикстуре.
3. Хостируемый раздел: route group, резолв домена, sitemap/robots, JSON-LD; документ по TLS и деплою.
4. Интеграция с `publication_operations` и очередью `publish`.

### Этап 3. Материалы
1. `site_articles`, `site_article_revisions`, очередь `site-articles`.
2. Правило выбора типа, квоты `cadence`, источники: RSS, посты канала, `audience_questions`, пробелы профиля.
3. Генерация с контекстом, валидатор ссылок, профиль качества `article`, `similarity_check`.
4. Экран подтверждения (и уведомление в бот по образцу `publication_review_tasks`), `approved_streak`, разблокировка `auto`.
5. Индексация опубликованного как `site_publication`.

### Этап 4. Зонд GEO/AEO
1. Генерация реестра вопросов ниши из профиля и `audience_questions`, версионирование реестра.
2. `site_visibility_probes`, прогон по подключённым движкам с бюджетом `ai_usage`.
3. Извлечение упоминаний бренда и конкурентов детерминированными правилами + сущностями из профиля.

### Этап 5. Отчёты
1. `site_reports`, сборка `payload`, шаблоны `summary_ru`, сравнение с предыдущим.
2. Экспорт PDF/Markdown/HTML/JSON, запись Markdown в базу знаний.
3. Крон `monthly`, вкладка «Отчёты».

### Этап 6. Тесты
- unit: правило выбора типа, квоты, валидатор ссылок, шаблоны формулировок, извлечение упоминаний;
- контракт: адаптеры на фикстурах, reconcile при `delivery_unknown`;
- integration: полный путь RSS → статья → одобрение → WordPress-фикстура → база знаний → отчёт;
- security: публикация без верификации домена запрещена, чужой `Host` → 404, инъекция в тексте страницы не меняет тип материала.

## 12. Definition of Done

1. Пользователь подключает сайт, подтверждает домен и получает `initial_audit` в PDF за один сеанс.
2. Материал невозможно опубликовать без одобрения человека, пока сайт в режиме `confirm`; переход в `auto` фиксируется в `audit_events`.
3. Ни один источник не порождает два материала; смысловой дубль отклоняется с указанием ближайшей страницы.
4. При обрыве сети во время публикации в WordPress статья не появляется дважды (контрактный тест на reconcile).
5. Отчёт `monthly` содержит дельту к предыдущему и статус прошлых рекомендаций; скачивается в PDF и Markdown; Markdown виден в базе знаний сайта.
6. В отчёте нет утверждений о трафике и позициях без подключённых интеграций.

## 13. Технические решения по открытым вопросам

Приняты 2 сентября 2026 года; продуктовая сторона делегировала технические решения.

1. **TLS и домены хостируемого раздела.** Этап 2 выпускается на служебном поддомене продукта `<slug>.sites.<домен Авроры>` под одним wildcard-сертификатом — никакой автоматизации выпуска сертификатов на старте. Собственный домен клиента (`news.<домен клиента>` через CNAME) добавляется отдельным подэтапом 2b с выпуском ACME HTTP-01 на reverse-proxy; до него `site_destinations.settings.custom_domain` остаётся пустым. Для SEO это честный компромисс: раздел на служебном домене индексируется и даёт ссылочную массу, но не наследует авторитет домена клиента — отчёт это прямо указывает в `limitations`.
2. **Бюджет зонда GEO.** Зонд работает в рамках существующего `ai_usage` с отдельным `reservation kind = 'site_probe'` и жёстким потолком на прогон: не более 12 вопросов × 3 движка. Отдельной тарификации нет; при исчерпании лимита прогон помечается `skipped_budget`, а отчёт сохраняет прошлый результат с пометкой.
3. **Интеграции Яндекс.Вебмастер / GSC** — отдельная спецификация после этапа 5; до неё раздел `seo` отчёта остаётся on-page и `required_integrations` заполнены всегда.
4. **Обложки статей.** Переиспользуется `media-generation` без изменений; брендированные обложки из `project_brand_kits` — после первых опубликованных материалов, когда появится основание для правил.
5. **База знаний сайта переносится на этап 3.** Расширение `knowledge_sources` / `knowledge_chunks` под `site_id` (раздел 4.4) затрагивает `indexSource`, `findSupport` и API знаний; на этапе 1 у него нет потребителя. Профиль сайта строится напрямую из `site_analysis_pages` / `site_analysis_sources` привязанного прогона, а индексация страниц в базу знаний выполняется на этапе 3 вместе с первым потребителем — проверкой дублей.
6. **Связь сайта с анализом.** Вместо нового `coverage_mode` в `site_analysis_jobs` добавляется nullable `site_id`. Существующий конвейер анализа не меняется; worker после стадии `saving` для job с `site_id` детерминированно строит `site_profiles` и `site_reports(kind='initial_audit')` в той же транзакции. Так один и тот же прогон обслуживает и OSINT-интервью, и профиль сайта без дублирования crawl.
7. **Подтверждение владения доменом.** Два способа, оба без внешних сервисов: TXT-запись `_aurora-site.<домен>` со значением токена (проверка через `node:dns`) или meta-тег `<meta name="aurora-site-verification" content="<токен>">` на главной странице (проверка через существующий `safe-http.mjs`). Токен — 32 байта случайности в base64url, проверка идемпотентна и оставляет запись в `audit_events`.
