// Почему план не собрался — словами и с действием.
//
// Диагноз всегда лежал в базе: каждый элемент плана несёт quality.violations с кодом
// нарушения. Страница его не читала и предлагала «выбрать другую модель» — совет, который
// не помогает ни при одной из настоящих причин. Отсутствие источника, обязательный
// дисклеймер и диапазон длины от модели не зависят вообще.
//
// QUALITY_FAILURE_GUIDE — единственное место, где код нарушения превращается в понятную
// причину и в следующий шаг. Тест держит его полным: новый гейт нельзя добавить, не
// объяснив человеку, что с ним делать.

const QUALITY_FAILURE_COPY = {
  empty: {
    title: "Модель не вернула текст",
    action: "Аврора повторит запрос автоматически. Уже готовые посты останутся в плане.",
    fix: "retry",
  },
  too_short: {
    title: "Пост короче желаемого объёма",
    action: "Аврора дополнит 2–3 конкретных аспекта темы по уже найденным источникам.",
    fix: "settings",
  },
  too_long: {
    title: "Пост длиннее желаемого объёма",
    action: "Аврора сократит только этот текст без потери фактов и вывода.",
    fix: "settings",
  },
  hook: {
    title: "Первая строка не похожа на короткий хук",
    action: "Аврора перепишет только первую строку и снова проверит весь пост.",
    fix: "settings",
  },
  address: {
    title: "Обращение на «ты» в канале, который говорит на «вы»",
    action: "Проверь обращение в настройках канала — модель следует ему, но иногда срывается на «ты».",
    fix: "settings",
  },
  profanity: {
    title: "В тексте грубая лексика, а она запрещена",
    action: "Пересобери план. Если срывается регулярно — смени модель.",
    fix: "retry",
  },
  profanity_required: {
    title: "Настройка требует мат, а модель его не добавила",
    action: "Опусти уровень мата ниже 100 в настройках канала: не каждая модель выполняет это требование.",
    fix: "settings",
  },
  forbidden_phrase: {
    title: "В тексте запрещённая формулировка",
    action: "Проверь список запрещённых формулировок в настройках: слишком общее слово блокирует почти любой текст.",
    fix: "settings",
  },
  forbidden_topic: {
    title: "Пост зашёл в стоп-тему",
    action: "Проверь список стоп-тем: если он пересекается с нишей канала, темы будут отваливаться постоянно.",
    fix: "settings",
  },
  dense_paragraph: {
    title: "Абзац длиннее разрешённого числа предложений",
    action: "Аврора разделит абзац кодом, не меняя факты и смысл.",
    fix: "settings",
  },
  structure: {
    title: "Нет отдельных хука, основной части и вывода",
    action: "Аврора сначала разложит готовые предложения по коротким смысловым блокам.",
    fix: "settings",
  },
  list: {
    title: "Список есть там, где запрещён, или нет там, где обязателен",
    action: "Аврора приведёт список к правилам канала без нового запроса к ИИ.",
    fix: "settings",
  },
  bold: {
    title: "Жирное выделение не по правилам канала",
    action: "Аврора исправит выделение кодом без изменения текста.",
    fix: "settings",
  },
  emoji: {
    title: "Эмодзи больше разрешённого",
    action: "Аврора уберёт лишние эмодзи кодом.",
    fix: "settings",
  },
  hashtags: {
    title: "Хэштегов больше разрешённого",
    action: "Аврора уберёт лишние хэштеги кодом.",
    fix: "settings",
  },
  disclaimer: {
    title: "Нет обязательного дисклеймера",
    action: "Проверь текст дисклеймера в настройках: он должен вставляться дословно, поэтому длинный текст модель обрезает.",
    fix: "settings",
  },
  meta_labels: {
    title: "В текст попали служебные метки промпта",
    action: "Аврора удалит служебные метки кодом и повторит проверку.",
    fix: "retry",
  },
  punctuation: {
    title: "Слишком много повторяющихся знаков препинания",
    action: "Аврора нормализует повторяющиеся знаки кодом.",
    fix: "retry",
  },
  truncated: {
    title: "Текст оборван на середине",
    action: "Аврора автоматически допишет только этот пост и снова проверит его.",
    fix: "retry",
  },
  no_sources: {
    title: "Под тему нет ни одного источника в базе знаний",
    action: "Добавь материалы в базу знаний канала. Профиль требует источник под каждый факт — без материалов пост не пройдёт ни с одной моделью.",
    fix: "knowledge",
  },
  weak_sources: {
    title: "Мало утверждений привязано к источникам",
    action: "Добавь материалов по теме или опусти требуемую долю ссылок в настройках канала.",
    fix: "knowledge",
  },
  invented: {
    title: "В тексте цифры, даты или номера статей, которых нет в источниках",
    action: "Добавь в базу знаний материалы с этими данными — иначе конкретику подтвердить нечем.",
    fix: "knowledge",
  },
  unsupported_semantic_claim: {
    title: "Утверждение противоречит источнику или прямо им опровергнуто",
    action: "Проверь материалы в базе знаний: скорее всего, там сказано обратное.",
    fix: "knowledge",
  },
  semantic_review_required: {
    title: "Автопроверка фактов не дала заключения",
    action: "Аврора повторит проверку автоматически. Пока заключения нет, текст не попадёт в готовый план.",
    fix: "retry",
  },
  insufficient_content: {
    title: "В тексте недостаточно содержательной мысли",
    action: "Повтори только этот пост или открой его в редакторе: короткий обрывок нельзя публиковать.",
    fix: "retry",
  },
  platform_limit: {
    title: "Текст не помещается в технический лимит площадки",
    action: "Сократи только этот пост до полного предложения — остальные публикации менять не нужно.",
    fix: "retry",
  },
  quality_threshold: {
    title: "Остались редакционные замечания",
    action: "Проверь пост перед публикацией или открой настройки качества, если правило больше не подходит каналу.",
    fix: "settings",
  },
  duplicate: {
    title: "Пост слишком похож на недавнюю публикацию",
    action: "Перепиши только этот пост с другой темой или другим углом подачи.",
    fix: "retry",
  },
};

const QUALITY_FAILURE_AXES = Object.freeze({
  empty: ["blocked", "provider_retry"],
  too_short: ["confirmation_required", "rewrite"],
  too_long: ["confirmation_required", "rewrite"],
  hook: ["confirmation_required", "rewrite"],
  address: ["confirmation_required", "deterministic_format"],
  profanity: ["blocked", "rewrite"],
  profanity_required: ["confirmation_required", "settings_change"],
  forbidden_phrase: ["blocked", "rewrite"],
  forbidden_topic: ["blocked", "settings_change"],
  dense_paragraph: ["confirmation_required", "deterministic_format"],
  structure: ["confirmation_required", "deterministic_format"],
  list: ["confirmation_required", "deterministic_format"],
  bold: ["confirmation_required", "deterministic_format"],
  emoji: ["confirmation_required", "deterministic_format"],
  hashtags: ["confirmation_required", "deterministic_format"],
  disclaimer: ["blocked", "deterministic_format"],
  meta_labels: ["confirmation_required", "deterministic_format"],
  punctuation: ["confirmation_required", "deterministic_format"],
  truncated: ["blocked", "provider_retry"],
  no_sources: ["blocked", "add_knowledge"],
  weak_sources: ["blocked", "add_knowledge"],
  invented: ["blocked", "rewrite"],
  unsupported_semantic_claim: ["blocked", "rewrite"],
  // Autopilot promises finished publications, not an editor task. When semantic validation
  // is temporarily unavailable, keep the draft internal and retry the provider automatically.
  semantic_review_required: ["confirmation_required", "provider_retry"],
  insufficient_content: ["blocked", "provider_retry"],
  platform_limit: ["blocked", "deterministic_format"],
  quality_threshold: ["confirmation_required", "settings_change"],
  duplicate: ["blocked", "rewrite"],
});

/**
 * One catalog owns both independent quality axes. Publication disposition answers whether
 * the current text may cross the publication boundary; repairStrategy answers what should
 * happen next. Keeping them separate prevents a harmless formatting miss from being treated
 * like an unsupported factual claim.
 */
export const QUALITY_FAILURE_GUIDE = Object.freeze(Object.fromEntries(
  Object.entries(QUALITY_FAILURE_COPY).map(([code, copy]) => {
    const [publicationDisposition, repairStrategy] = QUALITY_FAILURE_AXES[code] || [
      "blocked",
      "human_review",
    ];
    return [code, Object.freeze({
      ...copy,
      publicationDisposition,
      repairStrategy,
    })];
  }),
));

const guideFor = (code) =>
  QUALITY_FAILURE_GUIDE[code] || {
    title: `Проверка «${code}» не пройдена`,
    action: "Открой пост и посмотри замечание целиком.",
    fix: "review",
    publicationDisposition: "blocked",
    repairStrategy: "human_review",
  };

export function autopilotQualityDisposition(result) {
  const violations = Array.isArray(result?.violations) ? result.violations : [];
  let disposition = "ready";
  let repairStrategy = null;
  for (const violation of violations) {
    const guide = guideFor(String(violation?.code || ""));
    if (guide.publicationDisposition === "blocked") {
      if (disposition !== "blocked") repairStrategy = guide.repairStrategy;
      disposition = "blocked";
      repairStrategy ||= guide.repairStrategy;
      continue;
    }
    if (guide.publicationDisposition === "confirmation_required" && disposition === "ready") {
      disposition = "confirmation_required";
      repairStrategy ||= guide.repairStrategy;
    }
  }
  return { publicationDisposition: disposition, repairStrategy };
}

function itemPassed(item) {
  return item?.aiReady === true &&
    String(item?.draft || "").trim().length > 0 &&
    item?.quality?.passed === true &&
    !["confirmation_required", "blocked"].includes(item?.quality?.publicationDisposition) &&
    item?.qualityBlocked !== true &&
    item?.reviewRequired !== true;
}

/**
 * Свести нарушения всех постов в короткий список причин. Считаем ПОСТЫ, а не нарушения:
 * «нет источника у 5 постов» — это про базу знаний, а «нет источника 5 раз» ни о чём не
 * говорит. Минорные замечания без блокера в список причин не попадают, если пост и так
 * прошёл: они не мешали.
 */
export function autopilotQualityFailureReport(items, expected = null) {
  const list = Array.isArray(items) ? items : [];
  const total = Math.max(0, Number(expected) || list.length);
  const counts = new Map();
  let passed = 0;
  let drafts = 0;

  for (const item of list) {
    if (String(item?.draft || "").trim() && item?.aiReady === true) drafts += 1;
    if (itemPassed(item)) {
      passed += 1;
      continue;
    }
    // No model text means a provider/build state, not three editorial defects. Do not
    // diagnose a missing hook or structure on an empty value: that produced the confusing
    // repeated counters that made one outage look like many bad posts.
    if (item?.aiReady !== true || !String(item?.draft || "").trim()) {
      counts.set("empty", (counts.get("empty") || 0) + 1);
      continue;
    }
    const violations = Array.isArray(item?.quality?.violations) ? item.quality.violations : [];
    const codes = new Set(
      violations
        .filter((violation) => {
          const guide = guideFor(String(violation?.code || ""));
          return violation?.blocker === true || guide.publicationDisposition === "blocked";
        })
        .map((violation) => String(violation?.code || ""))
        .filter(Boolean),
    );
    for (const code of codes) counts.set(code, (counts.get(code) || 0) + 1);
  }

  const causes = [...counts.entries()]
    .map(([code, count]) => ({ code, count, ...guideFor(code) }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));

  return {
    total,
    passed,
    failed: Math.max(0, total - passed),
    drafts,
    causes,
    // Главная причина решает, что предложить кнопкой: добавить материалы, поправить
    // профиль или действительно пересобрать план.
    primaryFix: causes[0]?.repairStrategy ?? null,
  };
}
