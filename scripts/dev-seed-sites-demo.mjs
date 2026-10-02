// Демо-стенд раздела «Мои сайты» для локальной разработки.
//
// Зачем: в локальной базе нет ни одного сайта, а проверять новый интерфейс нужно
// на реальных данных. Скрипт наполняет ЛОКАЛЬНУЮ базу так, как это сделал бы
// настоящий конвейер: страницы извлекаются реальным `extractSitePage`, отчёт
// собирается реальным `buildSiteAnalysisReport`, профиль и стартовый отчёт
// пишутся реальным `persistSiteProfileForAnalysis`. Руками вставляются только
// материалы (их генерирует ИИ, которого в seed нет) и сессия для браузера.
//
// Запуск:
//   node --env-file-if-exists=.env.local scripts/dev-seed-sites-demo.mjs
//   node --env-file-if-exists=.env.local scripts/dev-seed-sites-demo.mjs --reset
//
// Повторный запуск идемпотентен: демо-пользователь пересоздаётся целиком.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

import { buildSiteAnalysisReport, extractSitePage, DEFAULT_SITE_CRAWL_LIMITS } from "../src/lib/site-crawler.mjs";
import { buildSiteProfile } from "../src/lib/site-profile/profile.mjs";
import { buildCompetitorSummary, compareWithCompetitors } from "../src/lib/site-competitors/summary.mjs";
import { buildMonthlyReport } from "../src/lib/site-report/monthly.mjs";
import { persistSiteProfileForAnalysis } from "../worker/site-profile-persistence.mjs";

const DEMO_EMAIL = "sites-demo@aurora.local";
const DEMO_PROJECT = "АСПБ — демо стенд";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

const url = new URL(process.env.DATABASE_URL || "");
if (!LOOPBACK.has(url.hostname)) {
  console.error("Демо-стенд можно наполнять только в локальной базе. DATABASE_URL указывает на", url.hostname);
  process.exit(1);
}

/* ------------------------------------------------------------------ фикстуры */

function html({ title, description, h1, body, noindex = false, lang = "ru", schema = null }) {
  return `<!doctype html><html lang="${lang}"><head>
<meta charset="utf-8"><title>${title}</title>
<meta name="description" content="${description}">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ""}
<meta name="viewport" content="width=device-width, initial-scale=1">
${schema ? `<script type="application/ld+json">${JSON.stringify(schema)}</script>` : ""}
</head><body><header><nav><a href="/">Главная</a> <a href="/uslugi">Услуги</a> <a href="/blog">Блог</a> <a href="/kontakty">Контакты</a></nav></header>
<main><h1>${h1}</h1>${body}</main>
<footer><p>АСПБ, Санкт-Петербург. Телефон +7 812 000-00-00. <a href="/politika">Политика конфиденциальности</a></p></footer>
</body></html>`;
}

const paragraphs = (items) => items.map((text) => `<p>${text}</p>`).join("\n");

function aspbPages() {
  const base = "https://aspb-partners.ru";
  const pages = [
    {
      path: "/",
      page: {
        title: "АСПБ — юридическая поддержка бизнеса и банкротство",
        description: "Юридическая поддержка бизнеса в Санкт-Петербурге: банкротство, налоговые споры, сопровождение сделок и вебинары для предпринимателей.",
        h1: "Юридическая поддержка бизнеса",
        body: paragraphs([
          "АСПБ сопровождает предпринимателей с 2014 года: банкротство физических лиц и компаний, налоговые споры, договорная работа и защита активов.",
          "Мы работаем по фиксированной стоимости этапа и показываем план работ до подписания договора. В штате девять юристов, трое из них специализируются на банкротстве.",
          "За 2025 год мы провели 48 процедур банкротства и 120 консультаций для собственников бизнеса. Практика описана в разделах ниже.",
          "Вебинары и конференции для предпринимателей мы проводим каждый месяц, записи доступны в блоге.",
        ]),
      },
    },
    {
      path: "/uslugi",
      page: {
        title: "Услуги юридической компании АСПБ",
        description: "Банкротство физлиц и организаций, налоговые споры, юридическое сопровождение бизнеса, взыскание задолженности и защита активов.",
        h1: "Услуги",
        body: paragraphs([
          "Банкротство физических лиц: подготовка заявления, работа с кредиторами, сопровождение в арбитражном суде.",
          "Банкротство организаций: анализ обязательств, реструктуризация долгов, защита руководителя от субсидиарной ответственности.",
          "Налоговые споры: возражения на акты проверок, обжалование решений, снижение штрафов.",
          "Юридическое сопровождение бизнеса: договоры, сделки, корпоративные решения, кадровые вопросы.",
        ]),
      },
    },
    {
      path: "/uslugi/bankrotstvo",
      page: {
        title: "Банкротство: юридическая помощь должникам и кредиторам",
        description: "Сопровождение процедуры банкротства: оценка перспектив, подготовка документов, работа с финансовым управляющим и судом.",
        h1: "Банкротство",
        body: paragraphs([
          "Процедура банкротства начинается с оценки: сколько долгов, есть ли имущество, были ли сделки за последние три года.",
          "Мы готовим заявление, собираем документы, взаимодействуем с финансовым управляющим и представляем интересы клиента в суде.",
          "Срок процедуры зависит от количества кредиторов и наличия имущества: обычно от шести до двенадцати месяцев.",
          "Стоимость складывается из государственной пошлины, депозита суда и работы юриста; мы фиксируем её в договоре до начала.",
        ]),
      },
    },
    {
      path: "/uslugi/bankrotstvo/fizicheskih-lic",
      page: {
        title: "Банкротство физических лиц: как списать долги по 127-ФЗ",
        description: "Как проходит банкротство физлица: условия, документы, сроки, последствия и стоимость процедуры списания долгов.",
        h1: "Банкротство физических лиц",
        body: paragraphs([
          "Списать долги через банкротство может гражданин с задолженностью от 500 тысяч рублей и просрочкой более трёх месяцев.",
          "Судебная процедура занимает от шести месяцев: суд вводит реализацию имущества или реструктуризацию долга.",
          "Мы сопровождаем клиента на каждом этапе: от сбора справок до получения определения о завершении процедуры.",
        ]),
      },
    },
    {
      path: "/uslugi/soprovozhdenie",
      page: {
        title: "Юридическое сопровождение бизнеса и налоговые споры",
        description: "Абонентское юридическое сопровождение бизнеса: договоры, сделки, налоговые споры, кадры и корпоративные решения.",
        h1: "Юридическое сопровождение бизнеса",
        body: paragraphs([
          "Мы берём на себя договорную работу: проверяем контрагентов, готовим протоколы разногласий и сопровождаем сделки.",
          "Налоговые споры ведём с этапа проверки: возражения на акт, апелляция, суд. За 2025 год снизили требования по восьми делам.",
          "Формат работы — абонентское обслуживание с фиксированным числом часов в месяц и выделенным юристом.",
        ]),
      },
    },
    {
      path: "/blog",
      page: {
        title: "Блог АСПБ: право, налоги и экономика кризиса",
        description: "Разборы изменений законодательства, практика банкротства и налоговая безопасность бизнеса от юристов АСПБ.",
        h1: "Блог",
        noindex: true,
        body: paragraphs([
          "Мы публикуем разборы изменений законодательства и практику по делам, которые ведём.",
          "Свежие материалы: экономика кризиса, изменения в банкротстве, налоговый контроль сделок.",
        ]),
      },
    },
    {
      path: "/blog/ekonomika-krizisa",
      page: {
        title: "Экономика кризиса: что меняется для бизнеса",
        description: "Как кризис меняет договорную работу, обязательства и налоговую нагрузку компании и что делать руководителю.",
        h1: "Экономика кризиса: что меняется для бизнеса",
        body: paragraphs([
          "В кризис первыми ломаются договоры: условия расторжения и штрафы становятся главным риском для бизнеса.",
          "Второй риск — кассовый разрыв: отсрочки по обязательствам нужно оформлять юридически, иначе они превращаются в спор.",
          "Третий — ответственность руководителя: решения кризисного периода суды проверяют отдельно от обычной практики.",
        ]),
      },
    },
    {
      path: "/blog/vebinary-2026",
      page: {
        title: "Вебинары и конференции АСПБ 2026",
        description: "Расписание вебинаров и конференций для предпринимателей: банкротство, налоги, договорная работа.",
        h1: "Вебинары 2026",
        noindex: true,
        body: paragraphs([
          "Каждый месяц мы проводим вебинар для предпринимателей: разбираем практику и отвечаем на вопросы.",
          "Записи прошлых вебинаров доступны по запросу у менеджера.",
        ]),
      },
    },
    {
      path: "/kontakty",
      page: {
        title: "Контакты АСПБ",
        description: "Адрес офиса, телефон и реквизиты юридической компании АСПБ в Санкт-Петербурге.",
        h1: "Контакты",
        body: paragraphs([
          "Офис: Санкт-Петербург, Лиговский проспект, 74, офис 312.",
          "Телефон: +7 812 000-00-00. Почта: info@aspb-partners.ru",
        ]),
      },
    },
    {
      path: "/ceni",
      page: {
        title: "Стоимость услуг",
        description: "Стоимость юридических услуг: банкротство, сопровождение бизнеса, налоговые споры.",
        h1: "Стоимость",
        noindex: true,
        body: paragraphs([
          "Стоимость банкротства физлица — от 120 000 рублей плюс пошлина и депозит суда.",
          "Абонентское сопровождение бизнеса — от 60 000 рублей в месяц.",
        ]),
      },
    },
    {
      // Страница, которую рисует JavaScript: контент есть, но без исполнения скриптов его не видно.
      path: "/magazin",
      raw: `<!doctype html><html lang="ru"><head>
<meta charset="utf-8"><title>Магазин юридических документов</title>
<meta name="description" content="Конструктор документов для бизнеса: договоры, претензии, заявления.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/static/app.css">
<script src="/static/vendor.js"></script><script src="/static/app.js"></script><script src="/static/chunk-3.js"></script>
</head><body><div id="root"></div></body></html>`,
    },
    {
      path: "/politika",
      page: {
        title: "Политика конфиденциальности",
        description: "Политика обработки персональных данных сайта aspb-partners.ru.",
        h1: "Политика конфиденциальности",
        noindex: true,
        body: paragraphs([
          "Мы обрабатываем персональные данные только для оказания услуг и не передаём их третьим лицам без согласия.",
        ]),
      },
    },
  ];
  return pages.map(({ path, page, raw }) => extractSitePage(raw ?? html(page), new URL(path, base), 200));
}

function techPravoPages() {
  const base = "https://tech-pravo.ru";
  const pages = [
    extractSitePage(html({
      title: "ТехнологИИ Права — юридические разборы технологий",
      description: "Медиа о праве и технологиях: персональные данные, ИИ-регулирование, интеллектуальная собственность.",
      h1: "Право и технологии",
      body: paragraphs([
        "Разбираем, как регулирование данных и искусственного интеллекта влияет на продукты и команды.",
        "Публикуем разборы законов, судебной практики и требований регуляторов к цифровым сервисам.",
      ]),
    }), new URL("/", base), 200),
  ];
  const topics = [
    "personalnye-dannye", "regulirovanie-ii", "intellektualnaya-sobstvennost", "dogovory-saas",
    "reklama-i-marketing", "avtorskie-prava", "sudebnaya-praktika", "dannyе-polzovateley",
    "licenzionnye-soglasheniya", "kiberbezopasnost", "nalogi-dlya-it", "reestry-i-operatori",
    "soglasie-na-obrabotku", "transgranichnaya-peredacha", "age-verification", "ii-v-medicine",
    "elektronnaya-podpis", "markirovka-reklamy", "treteyskie-soglasheniya", "tz-i-prava",
  ];
  topics.slice(0, 19).forEach((slug, index) => {
    pages.push(extractSitePage(html({
      title: `${slug.replaceAll("-", " ")} — разбор ТехнологИИ Права`,
      description: `Разбор темы ${slug.replaceAll("-", " ")}: требования закона, практика и что делать продукту.`,
      h1: slug.replaceAll("-", " "),
      body: paragraphs([
        `Материал ${index + 2} из цикла о праве и технологиях: разбираем требования регуляторов и практику применения.`,
        "Ниже — выводы для продукта, риски и список документов, которые нужно подготовить команде.",
      ]),
    }), new URL(`/${slug}`, base), 200));
  });
  return pages;
}

const ARTICLES = [
  {
    type: "machine_readable_page",
    origin: "gap",
    title: "АСПБ — Экономика кризиса | Юридическая поддержка",
    slug: "aspb-ekonomika-krizisa-yuridicheskaya-podderzhka",
    description: "Разбираем, что меняется в экономике кризиса и как юридическая поддержка помогает бизнесу удержать устойчивость.",
    body: `Экономика кризиса — это не только про падение спроса. Это про скорость решений: чем раньше компания пересматривает договоры, обязательства и налоговую нагрузку, тем дешевле обходится выход из кризиса.

Мы собрали практику АСПБ по сопровождению бизнеса в кризисных периодах: реструктуризация долгов, работа с контрагентами, налоговые споры и защита активов.

## Что меняется первым

1. Договорная база: условия расторжения и штрафы становятся главным риском.
2. Кассовый разрыв: отсрочки по обязательствам требуют юридического оформления.
3. Ответственность руководителя: решения периода кризиса проверяются отдельно.

## Как мы работаем

Мы начинаем с аудита обязательств и заканчиваем сопровождением спора. Каждый этап фиксируется письменно, чтобы у бизнеса оставался след решений.`,
    status: "needs_review",
    quality: { wordCount: 640, issues: [{ code: "no_internal_links", severity: "warning", message: "Нет ссылок на страницы сайта: добавьте 2–3 перелинковки" }] },
    similarity: { verdict: "ok", maxScore: 0.18, nearestUrl: "https://aspb-partners.ru/blog/ekonomika-krizisa" },
    createdDaysAgo: 18,
  },
  {
    type: "company_news",
    origin: "manual",
    title: "Вайб-кодинг: как меняется роль разработчика и что это значит для бизнеса",
    slug: "vajb-koding-rol-razrabotchika",
    description: "Вайб-кодинг меняет роль разработчика: разбираем, что это значит для бизнеса и как выстроить процесс.",
    body: `Вайб-кодинг — это не просто модный термин, а смена парадигмы в разработке. Вместо ручного написания кода команда формулирует задачу и проверяет результат.

## Что меняется для бизнеса

Скорость прототипирования растёт, но растёт и цена ошибки в постановке задачи. Проверка результата становится отдельной ролью.`,
    status: "needs_review",
    quality: { wordCount: 410, issues: [] },
    similarity: { verdict: "ok", maxScore: 0.11, nearestUrl: null },
    createdDaysAgo: 23,
  },
  {
    type: "company_news",
    origin: "manual",
    title: "АСПБ: один маршрут вместо параллельных залов — программа конференции 2026",
    slug: "aspb-programma-konferencii-2026",
    description: "Программа конференции АСПБ 2026: один маршрут вместо параллельных залов и практические разборы.",
    body: `В 2026 году мы меняем формат конференции: вместо параллельных залов — один маршрут, чтобы никто не выбирал между темами.

Программа собрана из практических разборов: банкротство, налоги, договорная работа.`,
    status: "needs_review",
    quality: { wordCount: 320, issues: [] },
    similarity: { verdict: "ok", maxScore: 0.09, nearestUrl: null },
    createdDaysAgo: 24,
  },
  {
    type: "audience_answer",
    origin: "audience_question",
    title: "Как выбрать юриста по банкротству: 7 вопросов к кандидату",
    slug: "kak-vybrat-yurista-po-bankrotstvu",
    description: "Семь вопросов, которые стоит задать юристу по банкротству до подписания договора.",
    body: `Выбор юриста по банкротству определяет, сколько времени и денег займёт процедура. Вот семь вопросов, которые стоит задать до договора.

1. Сколько процедур вы провели лично?
2. Кто ведёт дело: вы или помощник?`,
    status: "needs_review",
    quality: { wordCount: 520, issues: [] },
    similarity: { verdict: "warn", maxScore: 0.71, nearestUrl: "https://aspb-partners.ru/uslugi/bankrotstvo" },
    createdDaysAgo: 27,
  },
];

/* --------------------------------------------------------- конкуренты */

function competitorPages(domain, { pages, words, schema }) {
  const base = `https://${domain}`;
  return Array.from({ length: pages }, (_, index) => {
    const path = index === 0 ? "/" : `/uslugi-${index}`;
    const ld = schema && index < 2
      ? `<script type="application/ld+json">{"@type":"${index === 0 ? "Organization" : "FAQPage"}"}</script>`
      : "";
    const text = `Услуги по банкротству и налогам: разбор практики, сроки, стоимость и риски. ${"Подробности и примеры из практики. ".repeat(Math.round(words / 6))}`;
    return extractSitePage(html({
      title: `${domain} — услуга ${index + 1}`,
      description: `Практика по банкротству и налогам: ${domain}`,
      h1: `Услуга ${index + 1}`,
      body: `<p>${text}</p>`,
      schema: null,
    }).replace("</head>", `${ld}</head>`), new URL(path, base), 200);
  });
}

async function seedCompetitors(site, definitions) {
  for (const definition of definitions) {
    const created = await client.query(
      `insert into site_competitors (site_id, project_id, user_id, domain, canonical_url)
       values ($1, $2, $3, $4, $5)
       on conflict (site_id, domain) do nothing
       returning id`,
      [site.id, site.project_id, site.user_id, definition.domain, `https://${definition.domain}/`],
    );
    if (!created.rows[0]) continue;
    const pages = competitorPages(definition.domain, definition);
    const report = buildSiteAnalysisReport(new URL(`https://${definition.domain}/`), pages, DEFAULT_SITE_CRAWL_LIMITS, {});
    const summary = buildCompetitorSummary({ domain: definition.domain, pages, report });
    await client.query(
      `update site_competitors
          set status = 'ready', summary = $3::jsonb, crawled_at = now(), updated_at = now()
        where id = $1 and site_id = $2`,
      [created.rows[0].id, site.id, JSON.stringify(summary)],
    );
  }
}

/* ------------------------------------------------------------------ seed */

const client = new pg.Client({ connectionString: url.href });

function sessionToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token, "utf8").digest("hex") };
}

/** Один прогон аудита: задание, профиль и стартовый отчёт — теми же функциями, что в worker'е. */
async function seedAnalysisRun(site, pages, { checkedAt, runRevision }) {
  const target = new URL(site.canonical_url);
  const report = buildSiteAnalysisReport(target, pages, DEFAULT_SITE_CRAWL_LIMITS, {});
  const snapshotHash = "sha256:" + createHash("sha256").update(JSON.stringify(pages.map((page) => page.url))).digest("hex");
  const job = await client.query(
    `insert into site_analysis_jobs
       (user_id, project_id, request_id, idempotency_key, request_fingerprint, target_url, confirmed_domain,
        consented_at, status, stage, progress, limits, result, site_id, run_revision, snapshot_hash,
        question_count, answered_count, completed_at, coverage_mode, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'ready','ready',100,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,'site_only',$17,$17)
     returning id`,
    [
      site.user_id, site.project_id, `demo-${randomUUID()}`, `demo-${randomUUID()}`, "demo-fingerprint",
      site.canonical_url, site.confirmed_domain, new Date(checkedAt.getTime() - 24 * 60 * 60 * 1000),
      JSON.stringify(DEFAULT_SITE_CRAWL_LIMITS), JSON.stringify(report), site.id, runRevision, snapshotHash,
      51, report?.interview?.answeredCount ?? 38, checkedAt, checkedAt,
    ],
  );
  const analysisId = Number(job.rows[0].id);
  const persisted = await persistSiteProfileForAnalysis(client, {
    analysisId, runRevision, siteId: site.id, pages, report, snapshotHash, checkedAt, now: checkedAt,
  });
  const profile = buildSiteProfile({ confirmedDomain: site.confirmed_domain, pages, report, checkedAt });
  return { analysisId, profileId: persisted.profileId, reportId: persisted.reportId, profile };
}

async function seedSite(site, pages, { withArticles }) {
  const checkedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

  // Первый прогон — по части страниц и раньше по времени: в истории аудитов должно быть
  // с чем сравнивать, иначе блок «что изменилось» нечем проверить.
  if (withArticles) {
    await seedAnalysisRun(site, pages.slice(0, 5), {
      checkedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
      runRevision: 1,
    });
  }

  // Конкуренты добавляются до текущего прогона: иначе в отчёте не будет сравнения,
  // ведь снимки читаются в момент сборки отчёта.
  if (withArticles) {
    await seedCompetitors(site, [
      { domain: "rival-bankrot.ru", pages: 8, words: 420, schema: true },
      { domain: "pravo-help.ru", pages: 4, words: 180, schema: false },
    ]);
  }

  const current = await seedAnalysisRun(site, pages, { checkedAt, runRevision: withArticles ? 2 : 1 });
  const { profile } = current;

  // Ежемесячный отчёт: тот же builder, что и в планировщике сайта.
  const previous = await client.query(
    "select id, payload from site_reports where site_id = $1 and kind = 'initial_audit' order by id limit 1",
    [site.id],
  );
  const period = { start: checkedAt.toISOString(), end: new Date(checkedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString() };
  const competitorRows = await client.query(
    "select domain, status, summary from site_competitors where site_id = $1 order by created_at asc, id asc",
    [site.id],
  );
  const monthly = buildMonthlyReport({
    site: { confirmedDomain: site.confirmed_domain, canonicalUrl: site.canonical_url, verificationState: site.verification_state },
    profile,
    period,
    competitors: competitorRows.rows.length > 0
      ? compareWithCompetitors(profile, competitorRows.rows.map((item) => ({ domain: item.domain, status: item.status, summary: item.summary })))
      : null,
    publications: withArticles ? { published: 0, rejectedDuplicates: 0, pendingReview: ARTICLES.length, failed: 0 } : {},
    probe: null,
    previousReport: previous.rows[0] ? { id: Number(previous.rows[0].id), payload: previous.rows[0].payload } : null,
    generatedAt: new Date(checkedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
  });
  const monthlyRow = await client.query(
    `insert into site_reports (site_id, kind, profile_id, previous_report_id, payload, summary_ru, status, created_at)
     values ($1,'monthly',$2,$3,$4::jsonb,$5,'ready',$6) returning id`,
    [
      site.id, current.profileId, previous.rows[0]?.id ?? null, JSON.stringify(monthly.payload), monthly.summaryRu,
      new Date(checkedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
    ],
  );

  if (withArticles) {
    for (const article of ARTICLES) {
      const created = new Date(Date.now() - article.createdDaysAgo * 24 * 60 * 60 * 1000);
      await client.query(
        `insert into site_articles
           (site_id, project_id, user_id, article_type, origin, source_key, title, slug, meta_description,
            body_markdown, internal_links, evidence_keys, similarity_check, quality, version, status, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'[]'::jsonb,'[]'::jsonb,$11::jsonb,$12::jsonb,1,$13,$14,$14)`,
        [
          site.id, site.project_id, site.user_id, article.type, article.origin, `${article.origin}:${article.slug}`,
          article.title, article.slug, article.description, article.body,
          JSON.stringify(article.similarity), JSON.stringify(article.quality), article.status, created,
        ],
      );
    }
  }

  return { analysisId: current.analysisId, profileId: current.profileId, reportId: current.reportId, monthlyReportId: Number(monthlyRow.rows[0].id), profile };
}

async function main() {
  const reset = process.argv.includes("--reset");
  await client.connect();

  const existing = await client.query("select id from users where email = $1", [DEMO_EMAIL]);
  if (existing.rows[0] && !reset) {
    console.log("Демо-пользователь уже есть. Запусти с --reset, чтобы пересоздать стенд.");
  }
  if (existing.rows[0]) {
    const demoUserId = existing.rows[0].id;
    const demoProjects = "select id from projects where created_by_user_id = $1";
    await client.query("delete from user_project_preferences where user_id = $1", [demoUserId]);
    await client.query("delete from project_members where user_id = $1", [demoUserId]);
    await client.query(`delete from audit_events where project_id in (${demoProjects})`, [demoUserId]);
    await client.query(`delete from site_analysis_jobs where project_id in (${demoProjects})`, [demoUserId]);
    await client.query(`delete from sites where project_id in (${demoProjects})`, [demoUserId]);
    await client.query("delete from projects where created_by_user_id = $1", [demoUserId]);
    await client.query("delete from users where id = $1", [demoUserId]);
  }

  const user = await client.query(
    "insert into users (email, name, onboarding_completed_at) values ($1, $2, now()) returning id",
    [DEMO_EMAIL, "Демо АСПБ"],
  );
  const userId = Number(user.rows[0].id);
  const project = await client.query(
    "insert into projects (name, created_by_user_id) values ($1, $2) returning id",
    [DEMO_PROJECT, userId],
  );
  const projectId = Number(project.rows[0].id);
  await client.query(
    "insert into project_members (project_id, user_id, role, status) values ($1,$2,'owner','active')",
    [projectId, userId],
  );
  await client.query(
    `insert into user_project_preferences (user_id, selected_project_id) values ($1,$2)
     on conflict (user_id) do update set selected_project_id = excluded.selected_project_id, updated_at = now()`,
    [userId, projectId],
  );

  const seeded = [];
  const sites = [
    { domain: "aspb-partners.ru", url: "https://aspb-partners.ru/", pages: aspbPages(), articles: true, verification: "unverified", createdDaysAgo: 12 },
    { domain: "tech-pravo.ru", url: "https://tech-pravo.ru/", pages: techPravoPages(), articles: false, verification: "unverified", createdDaysAgo: 30 },
  ];

  for (const item of sites) {
    const verificationToken = randomBytes(32).toString("base64url");
    const row = await client.query(
      `insert into sites (project_id, user_id, confirmed_domain, canonical_url, verification_state, verification_token, status, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,'active',$7,$7) returning *`,
      [
        projectId, userId, item.domain, item.url, item.verification, verificationToken,
        new Date(Date.now() - item.createdDaysAgo * 24 * 60 * 60 * 1000),
      ],
    );
    const site = row.rows[0];
    const result = await seedSite(site, item.pages, { withArticles: item.articles });
    seeded.push({ domain: item.domain, pages: item.pages.length, gaps: result.profile.gaps.length, topics: result.profile.topics.length, seo: result.profile.technical.seoScore, geo: result.profile.technical.geoScore });
  }

  const session = sessionToken();
  await client.query(
    `insert into sessions (token_hash, user_id, expires_at, device, credential_epoch)
     select $1, u.id, now() + interval '30 days', 'dev-seed', u.credential_epoch
       from users u where u.id = $2`,
    [session.hash, userId],
  );

  console.log("Демо-стенд «Мои сайты» готов.");
  for (const item of seeded) console.log(" •", item.domain, `страниц: ${item.pages}`, `тем: ${item.topics}`, `пробелов: ${item.gaps}`, `SEO ${item.seo}`, `GEO ${item.geo}`);
  console.log("Проект:", projectId, "Пользователь:", userId);
  console.log("Cookie для браузера: sid=" + session.token);
}

main()
  .catch((error) => {
    console.error("Не удалось наполнить стенд:", error.message);
    process.exitCode = 1;
  })
  .finally(() => client.end());
