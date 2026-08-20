# Aurora production-readiness plan

Дата фиксации плана: 2026-08-20.

Этот документ — release runbook для текущего hardening-набора. Он не разрешает deploy
сам по себе и не заменяет CI, migration ledger audit или решение release owner.

## 1. Текущее доказанное состояние

| Gate | Состояние | Доказательство |
| --- | --- | --- |
| Unit/lint/build | Готово локально | `npm run lint`, `npm test`, `npm run build` |
| Migration policy | Готово локально | 92 additive migrations; legacy/fresh, checksum `30c7987…`, `434acde…`, unknown checksum и rerun проверены на disposable PostgreSQL |
| Schema readiness | Готово локально | legacy/partial/wrong checksum/full; legacy worker не создаёт consumer/heartbeat side effects |
| Site-analysis tenant isolation | Готово локально | Project A/B и legacy `NULL` проверены на disposable PostgreSQL |
| Trends hydration | Дефект не воспроизведён | production build: direct-open `scope=internet`, без `niche → internet` и hydration errors |
| Full product E2E | Готово локально | real web+workers, runtime restart, tenant/monthly/editorial/publication/tracking/export и 5 viewport-профилей; 0 browser runtime errors |
| Production ledger | Внешний блокер | Нужен только read-only результат SQL из раздела 3 |
| Rollback boundary | Внешний блокер | Нужен audit точной пары previous SHA → target SHA |
| Production infrastructure | Внешний блокер | Нужны protected variables/secrets и успешный full smoke |

### Снимок внешних доказательств — 2026-08-20

- Публичный `origin/main` — `72717ac0bd3fc5fb9f62fea0e462a9812d1f9977`; local hardening
  начат от его предка `17b7b80e9ccc4b4d8a4471f77447f6e178cebd7d`.
- CI run `32356834163` для `72717ac0…` завершён с `build=failure`; упавший шаг —
  `Real critical E2E`.
- Последний публичный deploy run `32270739318` для `17b7b80…` показывает успешный
  `Deploy release`, после которого упал `Verify production deployment`.
- Та историческая версия workflow не выполняла rollback после full-smoke failure.
  Поэтому публичные metadata не доказывают, какой release сейчас активен; до любых новых
  staging/production действий обязательна read-only проверка сервера ниже.
- Branch protection, `REQUIRED_CI_CHECKS`, environment variables и production ledger
  публично не читаются. Локальная GitHub credential недействительна, а локальные DB/Redis
  endpoints являются loopback-only; secret или remote database access не предполагались.

Release owner/infrastructure operator records the output of these read-only commands:

```bash
readlink -f /opt/aurora-current
git -C /opt/aurora-current rev-parse --verify HEAD
readlink -f /opt/aurora-previous
systemctl is-active aurora-web.service aurora-worker.service
curl -fsS --max-time 5 http://127.0.0.1:3002/api/health
```

Expected: exact 40-character current SHA, an existing previous release, both services
`active`, and minimal health JSON. Any mismatch is **STOP**; do not repair the symlink or
restart services as part of this read-only audit.

## 2. Роли и право остановки

До начала release назначаются конкретные люди:

- **Release owner** — выбирает target SHA, проверяет required CI и принимает go/no-go.
- **Database operator** — выполняет только read-only ledger audit, подтверждает backup/restore
  и schema compatibility boundary. Не редактирует `schema_migrations`.
- **Infrastructure operator** — подтверждает host fingerprint, systemd units, monitoring и
  protected GitHub environment.
- **Observer** — следит за readiness, error rate, publication queue и operational alerts.
- **Incident commander** — единственный принимает решение об остановке/rollback.

Любой участник может объявить stop при расхождении checksum, неоднозначной схеме,
неуспешном required check, недоступном rollback или появлении cross-project данных.

## 3. Gate A — read-only production/staging audit

Database operator выполняет:

```bash
psql "$DATABASE_URL" -X -f scripts/production-migration-ledger-audit.sql
```

Скрипт сам открывает `REPEATABLE READ, READ ONLY`, выводит одну JSON-строку без token
values и завершает транзакцию. Эквивалентный SQL:

```sql
BEGIN TRANSACTION READ ONLY;

SELECT name, checksum, applied_at
FROM public.schema_migrations
WHERE name = '20260916_session_token_hashes.sql';

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'sessions'
  AND column_name IN ('token', 'token_hash')
ORDER BY column_name;

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = to_regclass('public.sessions')
  AND (conname ILIKE '%token%' OR pg_get_constraintdef(oid) ILIKE '%token%')
ORDER BY conname;

SELECT
  count(*) AS total_rows,
  count(*) FILTER (WHERE expires_at > now()) AS active_rows,
  count(*) FILTER (
    WHERE nullif(to_jsonb(s)->>'token', '') IS NOT NULL
      AND (to_jsonb(s)->>'token') !~ '^[a-f0-9]{64}$'
  ) AS non_hash_token_rows,
  count(*) FILTER (
    WHERE nullif(to_jsonb(s)->>'token_hash', '') IS NOT NULL
      AND (to_jsonb(s)->>'token_hash') !~ '^[a-f0-9]{64}$'
  ) AS non_hash_token_hash_rows,
  count(*) FILTER (
    WHERE nullif(to_jsonb(s)->>'token', '') IS NOT NULL
      AND nullif(to_jsonb(s)->>'token_hash', '') IS NOT NULL
      AND (to_jsonb(s)->>'token') <> (to_jsonb(s)->>'token_hash')
  ) AS divergent_dual_rows
  ,count(*) FILTER (
    WHERE created_at <= (
      SELECT applied_at FROM public.schema_migrations
       WHERE name = '20260916_session_token_hashes.sql'
    )
      AND expires_at > (
        SELECT applied_at FROM public.schema_migrations
         WHERE name = '20260916_session_token_hashes.sql'
      )
  ) AS non_invalidated_pre_migration_rows
FROM public.sessions AS s;

COMMIT;
```

Решение:

- `30c7987…` или `434acde…` плюс совпадающая фактическая схема — продолжить staging rehearsal.
- Любой другой checksum — **STOP**, код и ledger не менять, открыть migration incident.
- Non-hash values, `non_invalidated_pre_migration_rows > 0` или расходящиеся dual
  columns — **STOP**, автоматический backfill запрещён. Активная hashed session с
  `created_at > applied_at` допустима: она создана уже после исторической инвалидизации.

## 4. Gate B — immutable release candidate

Release owner фиксирует один 40-символьный target SHA. Для него обязательны:

```bash
npm ci
npm run lint
npx tsc --noEmit
npm run test:focus
npm run test:migrations
npm run test:migrations:integration
npm run test:schema-readiness:integration
npm run test:site-analysis-tenant:integration
npm test
npm run build
npm run test:trends-hydration:e2e
npm run test:e2e:real
git diff --check
```

GitHub `REQUIRED_CI_CHECKS` содержит точные check-run names. Все внешние Actions во всех
workflow должны быть закреплены 40-символьными SHA. Deploy другого commit запрещён.

## 5. Gate C — staging rehearsal

На staging-копии с той же историей migrations, но без production writes:

1. Проверить backup и выполнить тест восстановления в отдельную базу.
2. Запустить старый release на исходной схеме и сохранить baseline smoke.
3. Применить forward migrations штатным `npm run db:migrate`.
4. Пока старый release ещё работает, проверить чтение и создание session через legacy
   `token`; затем проверить новый release через `token_hash`.
5. Запустить новый web и worker; readiness должен быть `200` только с operator bearer.
6. Повторить tenant A/B, monthly lineage, Autopilot deterministic-block и 20-way Growth
   concurrency scenarios.
7. Выполнить полный deployment smoke.
8. Выполнить rollback drill к предыдущему release без отката схемы; старый web и worker
   должны оставаться совместимыми с расширенной схемой.

Для изменённого manifest Database operator записывает в protected
`SCHEMA_ROLLBACK_AUDIT` только точную пару `<previous-sha>:<target-sha>` после успешного
шага 8. Без этой пары deployment блокируется.

## 6. Gate D — production go/no-go

Go допускается только когда одновременно выполнено всё:

- Gate A–C зелёные и привязаны к одному target SHA;
- проверенный backup существует, а restore rehearsal задокументирован;
- `PRODUCTION_SSH_KNOWN_HOSTS` и `PRODUCTION_SSH_HOST_FINGERPRINT` сверены вне deploy run;
- operator readiness token передан локальному и внешнему monitoring;
- web и worker имеют отдельные liveness/active checks;
- настроены alerts из `docs/production-operational-alerts.md`;
- назначены release owner, observer и incident commander;
- на время релиза запрещены параллельные schema/deploy operations.

Deploy выполняется только через protected GitHub workflow. Ручной SSH deploy и запись в
ledger запрещены.

## 7. Stop и rollback criteria

Немедленный stop до переключения symlink:

- build, required CI, migration или schema-boundary gate неуспешен;
- checksum неизвестен;
- staging schema отличается от утверждённой;
- backup/restore не доказан.

Rollback приложения после переключения:

- не активен web или worker;
- liveness не восстановился в заданный budget;
- full smoke неуспешен;
- readiness показывает schema/Redis/worker failure;
- обнаружена tenant leakage или publication deterministic bypass.

Rollback выполняется только к release, подтверждённому `SCHEMA_ROLLBACK_AUDIT`. Миграции
назад не применяются. Если предыдущий release несовместим с текущей схемой — **STOP**, а не
принудительный rollback.

## 8. Наблюдение после release

- **0–15 минут:** непрерывно health/readiness, systemd web+worker, queue heartbeat, HTTP 5xx.
- **15–60 минут:** publication failures, Autopilot blocks, tenant-denied events, DB/Redis
  saturation, Growth creation errors.
- **1–24 часа:** session renewal failures, delayed jobs, external provider degradation,
  operational signals и support incidents.

Release закрывается только после 60 минут без blocker-сигналов. Cleanup-миграция удаления
legacy `sessions.token` не входит в этот release; она планируется отдельно после полного
rollout и подтверждения отсутствия старых release instances.

## 9. Следующий уровень реального продукта

После безопасного первого release, отдельными задачами и с измеримыми acceptance criteria:

1. Автоматизированный restore rehearsal и измеренные RPO/RTO.
2. SLO для web, worker и publication delivery с error-budget alerts.
3. Capacity test для PostgreSQL connections, Redis queues и внешних provider budgets.
4. Ротация operator/token encryption keys по существующим runbooks.
5. Data-retention и privacy audit для analyses, drafts, audit events и exports.
6. Incident drill: provider outage, Redis loss, DB read-only и failed deployment smoke.
7. После появления нескольких web instances — canary/blue-green routing; до этого не
   называть single-VPS symlink deployment canary или полностью atomic.
