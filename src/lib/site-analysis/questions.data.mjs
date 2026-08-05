export const SITE_INTERVIEW_CATALOG_VERSION = "site-osint-questions-v1";

export const SITE_INTERVIEW_CATEGORIES = Object.freeze([
  ["organization", "Профиль организации и юридическая идентичность"],
  ["positioning", "Позиционирование и ключевые сообщения"],
  ["offer", "Продукты, услуги и бизнес-модель"],
  ["audience", "Аудитория и пользовательские сценарии"],
  ["content", "Контент-инвентаризация и актуальность"],
  ["experts", "Команда, эксперты и компетенции"],
  ["expert_activity", "Активность экспертов и внешние упоминания"],
  ["partners", "Партнёры, клиенты и связи"],
  ["public_activity", "Публичная активность, СМИ и события"],
  ["trust", "Репутация, кейсы и доказательства результатов"],
  ["funnel", "CTA, воронка, формы и посадочные страницы"],
  ["seo", "SEO, техническое качество и перелинковка"],
  ["geo", "GEO и готовность к AI-поиску"],
  ["social", "Социальные каналы и коммуникация"],
  ["reuse", "Контентные пробелы и повторное использование"],
  ["constraints", "Юридические, репутационные и доказательные ограничения"],
  ["recommendations", "Рекомендации, KPI и интеграции"],
].map(([id, title], index) => Object.freeze({ id, title, order: index + 1 })));

const SOURCE = Object.freeze({
  OWNED: ["owned_page", "owned_document", "structured_data"],
  PUBLIC: ["owned_page", "owned_document", "structured_data", "external_editorial", "partner_page", "event_page", "official_social", "public_registry"],
  ANALYTICS: ["search_console", "web_analytics", "cms", "crm", "official_social_api"],
});

function question(category, key, title, question, purpose, options = {}) {
  return Object.freeze({
    id: `${category}.${key}`,
    version: 1,
    category,
    title,
    question,
    purpose,
    answerType: options.answerType || "text",
    requiredEvidence: Object.freeze(options.requiredEvidence || ["content_fragment"]),
    allowedSourceKinds: Object.freeze(options.allowedSourceKinds || SOURCE.OWNED),
    minimumConfidence: options.minimumConfidence || "medium",
    required: options.required !== false,
    recommendationDimensions: Object.freeze(options.recommendationDimensions || []),
  });
}
export const SITE_INTERVIEW_QUESTIONS = Object.freeze([
  question("organization", "identity", "Идентичность организации", "Как организация называет себя, к какому типу относится и чем занимается?", "Установить проверяемую публичную идентичность организации.", { requiredEvidence: ["organization_name", "organization_description"], recommendationDimensions: ["positioning"] }),
  question("organization", "legal", "Юридические сведения", "Какие публичные юридические реквизиты и официальные контакты указаны и насколько они актуальны?", "Отделить маркетинговый бренд от проверяемого юридического лица.", { requiredEvidence: ["legal_name_or_registration", "contact"], allowedSourceKinds: SOURCE.PUBLIC, minimumConfidence: "high", recommendationDimensions: ["trust", "constraints"] }),
  question("organization", "geography", "География работы", "Какую географию работы организация заявляет и чем это подтверждается?", "Определить территориальный контекст коммуникации.", { requiredEvidence: ["geography_signal"], recommendationDimensions: ["audience", "channels"] }),

  question("positioning", "statement", "Ключевое обещание", "Как организация объясняет, какую проблему решает и для кого?", "Выделить фактическое ядро позиционирования.", { requiredEvidence: ["headline_or_description"], recommendationDimensions: ["message", "audience"] }),
  question("positioning", "differentiation", "Отличия от альтернатив", "Какие отличия, специализация или основания выбора заявлены и доказаны?", "Не путать рекламные заявления с подтверждёнными отличиями.", { requiredEvidence: ["differentiation_claim", "supporting_fact"], recommendationDimensions: ["message", "trust"] }),
  question("positioning", "consistency", "Согласованность сообщений", "Насколько ключевые сообщения согласованы между основными страницами?", "Найти конфликтующие или размытые формулировки.", { answerType: "matrix", requiredEvidence: ["cross_page_messages"], recommendationDimensions: ["message", "site"] }),

  question("offer", "catalog", "Продукты и услуги", "Какие продукты, услуги, направления и бесплатные материалы публично представлены?", "Построить проверяемый каталог предложений.", { answerType: "list", requiredEvidence: ["offer_name", "offer_page"], recommendationDimensions: ["content", "funnel"] }),
  question("offer", "commercial_model", "Коммерческая модель", "Какие цены, тарифы, условия покупки или признаки бизнес-модели доступны публично?", "Понять коммерческий контекст без догадок о выручке.", { requiredEvidence: ["price_or_commercial_signal"], recommendationDimensions: ["funnel", "cta"] }),
  question("offer", "development", "Приоритеты развития", "Какие направления организация продвигает активно, а какие представлены слабо или устарели?", "Определить наблюдаемые приоритеты и пробелы.", { answerType: "matrix", requiredEvidence: ["offer_coverage", "freshness_signal"], recommendationDimensions: ["content", "priority"] }),

  question("audience", "segments", "Сегменты аудитории", "Какие сегменты, роли и профессиональные контексты аудитории прямо названы?", "Не придумывать ICP без публичных сигналов.", { answerType: "list", requiredEvidence: ["audience_signal"], recommendationDimensions: ["audience", "channels"] }),
  question("audience", "needs", "Потребности и возражения", "Какие задачи, боли, вопросы и возражения аудитории раскрыты в содержании?", "Связать будущие темы с реальными пользовательскими задачами.", { answerType: "matrix", requiredEvidence: ["need_or_objection"], recommendationDimensions: ["themes", "formats"] }),
  question("audience", "journeys", "Пользовательские сценарии", "Какие публичные пути ведут от входной страницы к контакту, заявке, покупке или подписке?", "Проверить путь от информационного материала к действию.", { answerType: "matrix", requiredEvidence: ["internal_link", "cta_or_form"], recommendationDimensions: ["funnel", "landing_page"] }),

  question("content", "inventory", "Контент-инвентарь", "Какие статьи, новости, кейсы, исследования, FAQ, события и документы доступны?", "Составить инвентарь материалов по типам.", { answerType: "matrix", requiredEvidence: ["content_page"], recommendationDimensions: ["content", "reuse"] }),
  question("content", "themes", "Тематическая карта", "Какие темы и подтемы раскрываются регулярно и какими материалами подтверждаются?", "Построить тематические кластеры с доказательствами.", { answerType: "matrix", requiredEvidence: ["topic_occurrence"], recommendationDimensions: ["themes", "rubrics"] }),
  question("content", "freshness", "Актуальность контента", "Насколько контент датирован, обновляется и позволяет оценить актуальность?", "Не использовать устаревшие материалы как текущие без оговорки.", { answerType: "metric", requiredEvidence: ["publication_or_modified_date"], recommendationDimensions: ["priority", "reuse"] }),

  question("experts", "team", "Публичная команда", "Какие люди, роли и направления работы публично связаны с организацией?", "Построить реестр публичных профессиональных ролей.", { answerType: "list", requiredEvidence: ["person_name", "organization_role"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["experts"] }),
  question("experts", "competencies", "Подтверждённые компетенции", "Какие компетенции каждого эксперта подтверждены авторством, кейсами, исследованиями, выступлениями или сертификатами?", "Отделить заявленную должность от доказанной компетенции.", { answerType: "matrix", requiredEvidence: ["person", "competency_evidence"], allowedSourceKinds: SOURCE.PUBLIC, minimumConfidence: "high", recommendationDimensions: ["experts", "themes"] }),
  question("experts", "coverage", "Карта «эксперт → тема»", "Какие темы закреплены за экспертами, где есть пробелы и зависимость от одного человека?", "Подготовить обоснованное распределение экспертного контента.", { answerType: "matrix", requiredEvidence: ["person_topic_relation"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["experts", "rubrics", "risk"] }),

  question("expert_activity", "authorship", "Авторская активность", "Какие материалы имеют прямую атрибуцию экспертам и какова их наблюдаемая регулярность?", "Оценить реальную видимость экспертов в контенте.", { answerType: "metric", requiredEvidence: ["authored_material", "date"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["experts", "cadence"] }),
  question("expert_activity", "external_mentions", "Внешние экспертные упоминания", "Где эксперты выступают, публикуются или дают комментарии вне сайта организации?", "Оценить внешнее подтверждение экспертизы.", { answerType: "list", requiredEvidence: ["external_professional_mention"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["experts", "distribution"] }),
  question("expert_activity", "formats", "Форматы участия", "В каких форматах и на каких площадках эксперты проявляют публичную активность?", "Подобрать форматы на основе наблюдаемой практики.", { answerType: "matrix", requiredEvidence: ["person_activity_format"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["formats", "channels"] }),

  question("partners", "registry", "Реестр партнёров и клиентов", "Какие организации публично указаны как партнёры, клиенты, поставщики или участники совместных проектов?", "Собрать связи, не принимая логотип за доказанное партнёрство.", { answerType: "list", requiredEvidence: ["organization_relation_claim"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["partners"] }),
  question("partners", "validation", "Подтверждение связей", "Какие связи подтверждены обеими сторонами или содержательным первичным источником?", "Классифицировать заявленные, подтверждённые, исторические и конфликтующие связи.", { answerType: "matrix", requiredEvidence: ["bilateral_or_primary_relation_evidence"], allowedSourceKinds: SOURCE.PUBLIC, minimumConfidence: "high", recommendationDimensions: ["partners", "trust"] }),
  question("partners", "activity", "Партнёрская активность", "Какие совместные новости, события, кейсы, интеграции или материалы актуальны сейчас?", "Найти законные возможности совместного контента.", { answerType: "matrix", requiredEvidence: ["joint_activity", "date"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["partners", "formats"] }),

  question("public_activity", "timeline", "Хронология публичной активности", "Какие новости, события, исследования, награды и инициативы опубликованы и когда?", "Построить проверяемую временную линию.", { answerType: "matrix", requiredEvidence: ["dated_activity"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["calendar", "reuse"] }),
  question("public_activity", "media", "Присутствие в СМИ", "Какие внешние редакционные материалы и профессиональные упоминания подтверждают публичную заметность?", "Отделить собственные публикации от внешнего присутствия.", { answerType: "list", requiredEvidence: ["external_editorial_mention"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["distribution", "trust"] }),
  question("public_activity", "cadence", "Регулярность активности", "Есть ли устойчивый публичный ритм, сезонность или длительные провалы?", "Оценить контентный ритм без подмены отсутствующих данных нулём.", { answerType: "metric", requiredEvidence: ["activity_dates"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["cadence", "calendar"] }),

  question("trust", "cases", "Кейсы и результаты", "Какие кейсы описывают задачу, вклад, результат и способ проверки?", "Отделить содержательные кейсы от неподтверждённых обещаний.", { answerType: "matrix", requiredEvidence: ["case_description", "result_evidence"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["trust", "formats"] }),
  question("trust", "credentials", "Лицензии, сертификаты и награды", "Какие официальные документы, лицензии, сертификаты, рейтинги или награды доступны и актуальны?", "Выявить проверяемые сигналы доверия.", { answerType: "list", requiredEvidence: ["credential_or_award"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["trust"] }),
  question("trust", "contradictions", "Противоречия и риски доверия", "Какие сведения расходятся между страницами, устарели или не имеют достаточного подтверждения?", "Сделать репутационные ограничения явными.", { answerType: "list", requiredEvidence: ["conflicting_or_stale_signal"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["risk", "priority"] }),

  question("funnel", "cta", "Призывы к действию", "Какие CTA используются, на каких страницах и соответствуют ли они содержанию?", "Сопоставить контент и целевое действие.", { answerType: "matrix", requiredEvidence: ["cta"], recommendationDimensions: ["cta", "funnel"] }),
  question("funnel", "forms", "Формы и точки контакта", "Какие публичные формы и способы контакта доступны и какие данные они запрашивают?", "Понять наблюдаемую механику конверсии без отправки форм.", { answerType: "matrix", requiredEvidence: ["form_or_contact"], recommendationDimensions: ["funnel", "landing_page"] }),
  question("funnel", "landing_pages", "Посадочные страницы", "Какие страницы подходят для перехода из социальных сетей по конкретным темам?", "Связать темы публикаций с релевантным продолжением.", { answerType: "matrix", requiredEvidence: ["topic_page", "cta_or_next_step"], recommendationDimensions: ["landing_page", "channels"] }),

  question("seo", "metadata", "Поисковые метаданные", "Какие проблемы title, description, canonical, индексируемости и структуры заголовков обнаружены?", "Сформировать проверяемый технический аудит.", { answerType: "matrix", requiredEvidence: ["technical_value"], recommendationDimensions: ["seo", "priority"] }),
  question("seo", "linking", "Внутренняя перелинковка", "Как связаны тематические страницы и какие страницы могут быть изолированы?", "Проверить путь пользователя и распределение контекста.", { answerType: "matrix", requiredEvidence: ["internal_link_graph"], recommendationDimensions: ["seo", "site"] }),
  question("seo", "mobile_security", "Мобильность и базовая безопасность", "Какие наблюдаемые сигналы HTTPS, viewport, редиректов и доступности ресурсов зафиксированы?", "Описать только то, что проверено текущим crawl.", { answerType: "matrix", requiredEvidence: ["technical_value"], recommendationDimensions: ["site", "priority"] }),

  question("geo", "answerability", "Извлекаемость ответов", "Есть ли прямые определения, ответы, списки, таблицы и достаточный контекст для AI-поиска?", "Оценить возможность цитирования без домысливания.", { answerType: "matrix", requiredEvidence: ["structured_answer_signal"], recommendationDimensions: ["geo", "content"] }),
  question("geo", "attribution", "Авторство и актуальность", "Насколько явно указаны автор, издатель, дата и источники материалов?", "Повысить проверяемость контента для людей и AI-систем.", { answerType: "metric", requiredEvidence: ["author_date_source_signal"], recommendationDimensions: ["geo", "trust"] }),
  question("geo", "structured_data", "Структурированные сущности", "Какие типы schema.org и однозначные сущности обнаружены, а каких не хватает?", "Оценить машинную идентификацию организации и материалов.", { answerType: "matrix", requiredEvidence: ["structured_data"], recommendationDimensions: ["geo", "site"] }),

  question("social", "channels", "Связанные социальные каналы", "Какие официальные социальные площадки указаны и насколько ссылки актуальны?", "Установить наблюдаемый контур распространения.", { answerType: "list", requiredEvidence: ["official_social_link"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["channels"] }),
  question("social", "consistency", "Согласованность коммуникации", "Насколько темы, позиционирование и тон согласованы между сайтом и доступными социальными каналами?", "Найти расхождения без имитации недоступного внешнего анализа.", { answerType: "matrix", requiredEvidence: ["cross_channel_content"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["message", "channels"] }),
  question("social", "coverage", "Покрытие тем в соцсетях", "Какие подтверждённые темы сайта представлены или отсутствуют в социальных каналах?", "Выявить темы для законного расширения коммуникации.", { answerType: "matrix", requiredEvidence: ["site_topic", "social_topic"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["themes", "channels"] }),

  question("reuse", "assets", "Материалы для переработки", "Какие существующие материалы можно преобразовать в посты, видео, карточки, FAQ или подборки?", "Использовать уже подтверждённые знания организации.", { answerType: "matrix", requiredEvidence: ["content_asset"], recommendationDimensions: ["reuse", "formats"] }),
  question("reuse", "gaps", "Контентные пробелы", "Какие важные для предложения и аудитории темы раскрыты недостаточно или не подтверждены?", "Приоритизировать пробелы по доказательствам, а не по догадке.", { answerType: "matrix", requiredEvidence: ["coverage_gap_signal"], recommendationDimensions: ["themes", "priority"] }),
  question("reuse", "series", "Потенциальные серии", "Какие подтверждённые темы, эксперты, кейсы и события позволяют создать регулярные рубрики?", "Найти устойчивые серии вместо разовых идей.", { answerType: "matrix", requiredEvidence: ["repeating_topic_or_entity"], recommendationDimensions: ["rubrics", "calendar"] }),

  question("constraints", "claims", "Ограничения утверждений", "Какие заявления нельзя использовать без дополнительного подтверждения или юридической проверки?", "Не превращать маркетинговые формулировки в факты.", { answerType: "list", requiredEvidence: ["unsupported_or_sensitive_claim"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["risk", "review"] }),
  question("constraints", "freshness", "Ограничения актуальности", "Какие ответы опираются на старые, недатированные или односторонние источники?", "Показать пользователю необходимость актуализации.", { answerType: "list", requiredEvidence: ["stale_or_undated_source"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["risk", "priority"] }),
  question("constraints", "coverage", "Границы покрытия", "Какие выводы нельзя сделать в текущем режиме покрытия и какие источники нужны?", "Честно отделить site-only от внешнего OSINT и закрытых данных.", { answerType: "matrix", requiredEvidence: ["coverage_metadata"], allowedSourceKinds: [...SOURCE.PUBLIC, ...SOURCE.ANALYTICS], minimumConfidence: "high", recommendationDimensions: ["integrations"] }),

  question("recommendations", "priorities", "Приоритетные действия", "Какие действия по контенту, сайту и распространению прямо следуют из подтверждённых ответов?", "Собрать трассируемый backlog без необоснованных обещаний.", { answerType: "matrix", requiredEvidence: ["validated_answer_hook"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["priority", "backlog"] }),
  question("recommendations", "expert_partner_matrix", "Эксперты и партнёры в плане", "Какие матрицы «эксперт → тема → формат → площадка» и «партнёр → общая тема → формат» подтверждены?", "Не использовать имена людей и партнёров без основания.", { answerType: "matrix", requiredEvidence: ["validated_entity_relation"], allowedSourceKinds: SOURCE.PUBLIC, recommendationDimensions: ["experts", "partners", "formats"] }),
  question("recommendations", "measurement", "KPI и интеграции", "Какие KPI можно измерять сейчас, а для каких нужны Search Console, аналитика, CMS, CRM или API соцсетей?", "Отделить публичные сигналы от реальных бизнес-результатов.", { answerType: "matrix", requiredEvidence: ["measurement_capability"], allowedSourceKinds: [...SOURCE.PUBLIC, ...SOURCE.ANALYTICS], minimumConfidence: "high", recommendationDimensions: ["kpi", "integrations"] }),
]);

const ANSWER_TYPES = new Set(["text", "boolean", "list", "matrix", "metric"]);
const CONFIDENCE = new Set(["low", "medium", "high"]);

export function validateSiteInterviewCatalog(questions = SITE_INTERVIEW_QUESTIONS) {
  const errors = [];
  const ids = new Set();
  const categories = new Set(SITE_INTERVIEW_CATEGORIES.map((category) => category.id));
  for (const [index, item] of questions.entries()) {
    if (!item || typeof item !== "object") {
      errors.push(`question[${index}] is not an object`);
      continue;
    }
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u.test(String(item.id || ""))) errors.push(`question[${index}] has invalid id`);
    if (ids.has(item.id)) errors.push(`duplicate question id: ${item.id}`);
    ids.add(item.id);
    if (!categories.has(item.category)) errors.push(`${item.id}: unknown category`);
    if (!Number.isSafeInteger(item.version) || item.version < 1) errors.push(`${item.id}: invalid version`);
    for (const field of ["title", "question", "purpose"]) if (!String(item[field] || "").trim()) errors.push(`${item.id}: missing ${field}`);
    if (!ANSWER_TYPES.has(item.answerType)) errors.push(`${item.id}: invalid answerType`);
    if (!CONFIDENCE.has(item.minimumConfidence)) errors.push(`${item.id}: invalid minimumConfidence`);
    for (const field of ["requiredEvidence", "allowedSourceKinds", "recommendationDimensions"]) {
      if (!Array.isArray(item[field])) errors.push(`${item.id}: ${field} must be an array`);
    }
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors), count: ids.size });
}
