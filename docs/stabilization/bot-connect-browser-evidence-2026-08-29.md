# `/bot/connect` browser evidence — 2026-08-29

Статус: локальное доказательство одного browser surface. Оно не заменяет требуемую
Chromium/Firefox/WebKit matrix и QA sign-off.

## Окружение

- SHA основы: `90701d2a2fe0e44b99a0a8b81371773d6861812e` + текущий незакоммиченный diff.
- Next.js 16.2.12 dev web-only на `127.0.0.1:3100`.
- Один Codex in-app browser surface.
- Токены синтетические; production token и production mutation не использовались.
- `inspect` с valid-format unknown token выполнил только read path настроенного dev DB.

## Фактические результаты

| Сценарий | Наблюдение | Результат |
| --- | --- | --- |
| Stable route | `/bot/connect?source=telegram#token=<43-char synthetic>` открыл экран, не `/`. | Pass |
| URL hygiene | После обработки URL стал `/bot/connect?source=telegram`. | Pass |
| DOM/console | Synthetic token отсутствовал в DOM и browser console. | Pass |
| Server log | Логировал только cleaned pathname/query и `POST /api/bot/connect`; token отсутствовал. | Pass |
| Experimental boundary | `/bot` завершился на `/`; `/bot/connect` остался доступен. | Pass |
| Две вкладки | В обеих вкладках fragment был очищен, token в DOM отсутствовал. | Pass, но это не server reuse race |
| Reload/back/forward | Reload и forward вернули clean `/bot/connect`; back вернул `/`; token не восстановился в URL. | Pass |
| Mobile | Viewport 390×844: `clientWidth=390`, `scrollWidth=390`, H1 видим. | Pass |
| Hash на уже открытой странице | До дополнительного fix `#token=malformed` оставался в URL; browser evidence воспроизвёл дефект. | Fail до fix |
| Hashchange regression | После listener fix same-page `#token=short` очистился до `/bot/connect`, экран показал invalid state. | Pass после fix |

## Не подтверждено

- Firefox и WebKit;
- локальные Playwright engine binaries: cache directory отсутствует; установка не выполнялась;
- valid/expired/reused token на disposable QA DB через browser;
- одновременная server-side reuse race в нескольких вкладках;
- полный network trace и third-party telemetry capture;
- 30 последовательных прогонов и flake-rate <2%;
- независимый QA sign-off.

Поэтому BLK-01 остаётся частичным, несмотря на зелёное локальное browser evidence.
