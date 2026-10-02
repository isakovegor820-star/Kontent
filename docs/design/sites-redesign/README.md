# Прототип нового раздела «Мои сайты»

Интерактивный макет нового UX/UI раздела `/app/sites`. Это не картинка: HTML открывается в браузере,
табы кликабельны, вёрстка адаптивная.

> Раздел уже внедрён в код — см. [`../../sites-section-review-2026-10-02.md`](../../sites-section-review-2026-10-02.md), раздел 6.
> Скриншоты работающего раздела на локальном стенде: [`live/`](live/).
> Этот прототип остаётся как design-референс: он показывает замысел без данных и без логики.

## Как посмотреть

```bash
node --env-file-if-exists=.env.local scripts/dev-seed-sites-demo.mjs --reset   # стенд с данными
open docs/design/sites-redesign/index.html                                     # прототип в браузере
```

Скриншоты (1610×1048 и мобильный 430×932): [`screens/`](screens/).

- [`screens/0-bylo-stalo.png`](screens/0-bylo-stalo.png) — сравнение «было → стало»
- [`screens/1-overview.png`](screens/1-overview.png) — Обзор
- [`screens/2-audit.png`](screens/2-audit.png) — Аудит и видимость
- [`screens/3-materials.png`](screens/3-materials.png) — Материалы
- [`screens/4-publishing.png`](screens/4-publishing.png) — Публикация
- [`screens/5-reports.png`](screens/5-reports.png) — Отчёты
- [`screens/6-mobile-materials.png`](screens/6-mobile-materials.png) — телефон
- `*-full.png` — те же экраны целиком, без обрезки по высоте окна

## Файлы

| Файл | Что это |
|---|---|
| `index.html` | Разметка всех экранов прототипа, спрайт иконок, переключение табов |
| `theme.css` | Исходник стилей: импортирует реальную дизайн-систему продукта и добавляет компонентный слой прототипа |
| `app.css` | Собранный CSS (генерируется, в правках не нуждается) |
| `build-css.mjs` | Сборка `theme.css` → `app.css` через PostCSS + `@tailwindcss/postcss` |
| `shoot.mjs` | Скриншоты всех экранов через `playwright-core` (канал `chrome`) |

```bash
node docs/design/sites-redesign/build-css.mjs docs/design/sites-redesign/theme.css docs/design/sites-redesign/app.css
node docs/design/sites-redesign/shoot.mjs
```

CSS собирается из **настоящей дизайн-системы** (`src/app/globals.css` + `src/app/app/app-v3.css`),
поэтому цвета, радиусы, тени, типографика, состояния кнопок и системный шрифт в прототипе совпадают
с приложением. Классы прототипа (`p-*`) — это только короткие алиасы поверх реальных токенов:
при внедрении они заменяются на компоненты `Button`, `Card`, `Badge`, `Tabs` и утилиты Tailwind.

## Стандарт, который зафиксирован в макете

- контейнер `max-width: 1400px` (как в каркасе приложения), отступы 24 → 32 px;
- сетка 12 колонок, зазор 20 px; блоки занимают 12, 7+5 или 4×3 колонки;
- карточка: радиус 16 px, паддинг 24 px, тень `--shadow-sm`, граница `--border`;
- **правило «нет пустых окон»**: карточка либо заполнена содержимым, либо её футер прижат к низу;
  карточки в ряду равной высоты без внутренней пустоты; заглушка-подсказка допустима только
  как полноширинный экран с действием;
- табы — одна сегмент-полоса на всю ширину, пять равных сегментов;
- до 1024 px — одна колонка, переключатель сайтов и табы скроллятся по горизонтали.

## Связанные документы

- Ревью раздела и аудит анализа: [`../sites-section-review-2026-10-02.md`](../sites-section-review-2026-10-02.md)
- Исходная спецификация функции: [`../site-publishing-and-seo-spec.md`](../site-publishing-and-seo-spec.md)
- Спецификация анализа сайта: [`../site-analysis-osint-interview-spec.md`](../site-analysis-osint-interview-spec.md)
