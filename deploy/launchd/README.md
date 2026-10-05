# Локальные сервисы Авроры (launchd)

Здесь лежат определения локальных launchd-агентов. Раньше они жили только в
`~/Library/LaunchAgents/` — вне репозитория — и поэтому ни один тест не мог заметить,
что сервис разошёлся с контрактом запуска приложения. Именно так произошёл инцидент
2026-10-05: 22.09.2026 в коде появился обязательный `AURORA_TRUSTED_PROXY_HOPS`, плист
про него не знал, и web-процесс сутки отвечал `500` на каждый запрос, оставаясь «живым».

## Состав

| Агент | Что делает | Порт |
|---|---|---|
| `ru.aurora.web.plist` | `next start` — «прод» на этом компьютере | **3000** |
| `ru.aurora.publication-worker.plist` | BullMQ-воркер: Автопилот, расписания, RSS, медиа | — |
| `ru.aurora.health.plist` | раз в 5 минут проверяет `/api/health` и пишет сбой в журнал | — |

## Разделение портов

`ru.aurora.web` забирает **3000**, поэтому локальная разработка идёт на другом порту:

```bash
npm run dev -- -p 3100
```

Это осознанное решение: `http://localhost:3000` — постоянный «прод», который открывают
в браузере, а `3100` — рабочее окно разработки. Раньше оба претендовали на 3000, и
аудит 02.10.2026 выгружал агент, чтобы освободить порт.

## Установка

```bash
cd "/Users/egor/mvp and prod/platform"
scripts/install-local-services.sh              # web + сторож
scripts/install-local-services.sh --with-worker # ещё и BullMQ-воркер (осознанно!)
scripts/install-local-services.sh --dry-run     # только показать план
```

Скрипт копирует определения из этого каталога в `~/Library/LaunchAgents`, корректно
перезагружает агентов (с ожиданием выгрузки — `bootout` асинхронен, и `bootstrap`
сразу после него падает), **включает** задание перед загрузкой и в конце обязан получить
`200` от `/api/health`: молчаливо «живой» сервис — это и был инцидент 05.10.2026.

Про `enable`: задание может остаться в базе отключённых (`launchctl disable`) — тогда
`bootstrap` падает с «Input/output error», хотя плист валиден. Так воркер числился
`disabled` с 06.09.2026 и не поднимался, пока его не включили явно. Проверить:
`launchctl print-disabled "gui/$(id -u)" | grep aurora`.

Сторож поднимается **последним**, уже после подтверждённой готовности web: иначе его
`RunAtLoad` срабатывает, пока Next ещё не слушает порт, и в журнале появляется ложный
`FAIL`. Воркер по умолчанию **не** ставится: он запускает публикации, это отдельное
решение.

Проверка:

```bash
launchctl print "gui/$(id -u)/ru.aurora.web" | grep -A5 'environment = {'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/health   # ждём 200
```

## Пересборка `.next` — только при остановленном сервисе

`ru.aurora.web` отдаёт тот же каталог `.next`, который пишет `next build`. Сборка под
работающим процессом меняет `BUILD_ID` и хэши чанков, и живой сервер начинает отдавать
ошибки на уже загруженные страницы. Правильный порядок:

```bash
launchctl bootout "gui/$(id -u)/ru.aurora.web"     # остановить
npm run build                                       # собрать
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/ru.aurora.web.plist
```

`npm run build` теперь сам отказывается работать при живом сервисе (`scripts/build-target-guard.mjs`),
так что случайно этот порядок не нарушить.

### Если сборка может упасть — собери с возвратом

Сборка пишет `.next` поверх прежнего артефакта, поэтому неудачная сборка оставит сервис
без рабочего `.next`. Страховка — мгновенное переименование вместо копирования:

```bash
cd "/Users/egor/mvp and prod/platform"
launchctl bootout "gui/$(id -u)/ru.aurora.web"
mv .next .next-previous            # старый артефакт цел, места не удваивает
if npm run build; then
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/ru.aurora.web.plist
  curl -fsS http://127.0.0.1:3000/api/health && rm -rf .next-previous
else
  echo "сборка упала — возвращаю прежний артефакт"
  rm -rf .next && mv .next-previous .next
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/ru.aurora.web.plist
fi
```

### Две ловушки, проверенные на практике

- **Изолированная сборка правит `tsconfig.json`.** `next build` с `AURORA_NEXT_DIST_DIR`
  дописывает свой каталог в `include` и переформатирует файл — не коммитьте это как
  содержательное изменение (проверяйте `git diff tsconfig.json`).
- **Не собирайте, пока в дереве работает другая сессия.** Артефакт зафиксирует
  полуготовый код; именно поэтому пересборка ждёт, пока правки прекратятся.

## Обязательные переменные

| Переменная | Где | Почему |
|---|---|---|
| `AURORA_TRUSTED_PROXY_HOPS` | плист web + `.env.local` | boot-контракт: в `NODE_ENV=production` без неё процесс не обслуживает трафик |
| `TG_POLLING_ENABLED=0` | плист воркера | поллинг Telegram принадлежит боту прода на VPS |

`NODE_ENV=production` у web и `NODE_ENV=development` у воркера — как было исторически;
менять осознанно, а не заодно.
