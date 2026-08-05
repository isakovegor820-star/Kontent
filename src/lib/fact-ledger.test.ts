import { describe, expect, it } from "vitest";
import {
  buildFactLedger,
  factLedgerHash,
  preflightFactLedger,
  validateFactualOutput,
  type FactLedger,
} from "./fact-ledger";
import { DEFAULT_POST_SETTINGS } from "./post-settings";

const checkedAt = () => new Date("2026-08-01T12:00:00.000Z");

function baseLedger(overrides: Partial<FactLedger>): FactLedger {
  return {
    version: 1,
    policy: "closed_world",
    domain: "general",
    evidence: [],
    required: [],
    requiredUrls: [],
    forbiddenPhrases: [],
    forbiddenClaims: [],
    constraints: {},
    ...overrides,
  };
}

const requirement = (id: string, label: string, ...variants: string[]) => ({
  id,
  label,
  variants: variants.length ? variants : [label],
});

describe("five factual QA briefs", () => {
  it("1. Сообщество: сохраняет все пять аудиторий и блокирует выдуманный режим работы", () => {
    const facts = "Сообщество выросло из конференции. Аудитория: юристы, руководители, предприниматели, разработчики, эксперты. Цель — новая культура юридического бизнеса.";
    const ledger = baseLedger({
      evidence: [{ id: "brief", text: facts, source: "brief" }],
      required: [
        requirement("origin", "выросло из конференции"),
        ...["юристы", "руководители", "предприниматели", "разработчики", "эксперты"]
          .map((group) => requirement(`audience-${group}`, group)),
        requirement("goal", "новая культура юридического бизнеса"),
      ],
      forbiddenClaims: [
        requirement("daily", "ежедневная работа", "ежедневно", "каждый день"),
        requirement("operating-model", "операционная модель", "рабочие группы", "еженедельные разборы"),
      ],
      constraints: {
        maxEmoji: 0,
        maxHashtags: 0,
        maxQuestions: 0,
        cta: "forbidden",
        forbidArtificialContrast: true,
      },
    });
    const good = "Сообщество выросло из конференции. Здесь встречаются юристы, руководители, предприниматели, разработчики и эксперты. Цель сообщества — новая культура юридического бизнеса.";
    expect(validateFactualOutput(good, ledger, { now: checkedAt })).toMatchObject({
      passed: true,
      provenance: { coverage: "deterministic", semanticEntailment: "not_run" },
    });

    const bad = `${good} Это не просто сообщество — рабочие группы проводят встречи ежедневно.`;
    const result = validateFactualOutput(bad, ledger, { now: checkedAt });
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toEqual(expect.arrayContaining([
      "forbidden_claim",
      "unsupported_claim",
      "artificial_contrast",
    ]));
  });

  it("2. Банкротство: отклоняет недостижимый объём и новую юридическую конкретику", () => {
    const disclaimer = "Материал носит информационный характер и не является юридической консультацией.";
    const ledger = baseLedger({
      domain: "legal",
      requestedMinChars: 1600,
      requestedMaxChars: 1900,
      evidence: [
        { id: "term", text: "Процедура реализации имущества длится 6 месяцев.", source: "brief" },
        { id: "extension", text: "Срок может быть продлён определением арбитражного суда.", source: "brief" },
        { id: "home", text: "Единственное пригодное жильё обычно исключено по ст. 446 ГПК РФ.", source: "brief" },
        { id: "mortgage", text: "Ипотечное жильё — исключение.", source: "brief" },
        { id: "disclaimer", text: disclaimer, source: "brief" },
      ],
      required: [
        requirement("term", "6 месяцев", "6 месяцев", "шесть месяцев"),
        requirement("extension", "продление определением арбитражного суда", "продление определением арбитражного суда", "продлён определением арбитражного суда"),
        requirement("home", "ст. 446 ГПК РФ", "ст. 446 ГПК РФ", "статья 446 ГПК РФ"),
        requirement("mortgage", "ипотечное жильё — исключение", "ипотечное жильё — исключение", "для ипотечного жилья действует исключение"),
        requirement("disclaimer", disclaimer),
      ],
      constraints: { maxEmoji: 0, cta: "forbidden", forbidPromises: true, forbidAdvice: true },
    });

    expect(preflightFactLedger(ledger)).toMatchObject({
      passed: false,
      issues: [{ code: "insufficient_grounded_material", requestedMinChars: 1600 }],
    });
    const good = `Процедура реализации имущества длится шесть месяцев. Срок может быть продлён определением арбитражного суда. Единственное пригодное жильё обычно исключено по ст. 446 ГПК РФ. Для ипотечного жилья действует исключение. ${disclaimer}`;
    expect(validateFactualOutput(good, ledger, { now: checkedAt }).passed).toBe(true);

    const bad = `${good} Суд обычно продлевает процедуру на 3 месяца. Вам следует заранее подать ходатайство.`;
    expect(validateFactualOutput(bad, ledger, { now: checkedAt }).violations.map((item) => item.code)).toEqual(
      expect.arrayContaining(["unsupported_number", "advice"]),
    );
  });

  it("3. Engagement: выбирает ровно одно действие и задаёт ровно один вопрос с причиной", () => {
    const ledger = baseLedger({
      evidence: [{ id: "brief", text: "Допустимый выбор: поиск практики, проверка договора или подготовка документов.", source: "brief" }],
      forbiddenPhrases: ["вы когда-нибудь задумывались?"],
      constraints: {
        maxEmoji: 2,
        minQuestions: 1,
        maxQuestions: 1,
        requireWhyQuestion: true,
        cta: "forbidden",
        choiceGroups: [{
          id: "activity",
          label: "Действие",
          min: 1,
          max: 1,
          choices: [
            { id: "practice", label: "поиск практики", variants: ["поиск практики", "искать судебную практику"] },
            { id: "contract", label: "проверка договора", variants: ["проверка договора", "проверять договор"] },
            { id: "documents", label: "подготовка документов", variants: ["подготовка документов", "готовить документы"] },
          ],
        }],
      },
    });
    const good = "Проверка договора часто начинается с внимательного чтения каждого условия. Какой пункт обычно забирает больше внимания и почему? 🙂";
    expect(validateFactualOutput(good, ledger, { now: checkedAt }).passed).toBe(true);

    const bad = "Вы когда-нибудь задумывались? Поиск практики, проверка договора и подготовка документов экономят 90% времени. Что сложнее? Почему? 🚀🔥✨";
    const codes = validateFactualOutput(bad, ledger, { now: checkedAt }).violations.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining([
      "forbidden_phrase",
      "choice_count",
      "question_count",
      "emoji_limit",
      "unsupported_number",
    ]));
  });

  it("4. Анонс: сохраняет точные реквизиты и блокирует программу, спикера и другой URL", () => {
    const url = "https://example.com/techpravo-test";
    const facts = `15 сентября 2026 года в 19:00 состоится онлайн-встреча «Право и технологии: практика без хайпа». Для юристов и руководителей. Бесплатно. Регистрация до 14 сентября. ${url}`;
    const ledger = baseLedger({
      domain: "event",
      evidence: [{ id: "brief", text: facts, source: "brief" }],
      required: [
        requirement("date", "15 сентября 2026", "15 сентября 2026"),
        requirement("time", "19:00"),
        requirement("title", "Право и технологии: практика без хайпа"),
        requirement("lawyers", "юристы", "юристы", "юристов"),
        requirement("managers", "руководители", "руководители", "руководителей"),
        requirement("free", "бесплатно"),
        requirement("deadline", "регистрация до 14 сентября", "регистрация до 14 сентября"),
      ],
      requiredUrls: [url],
      forbiddenClaims: [
        requirement("speaker", "спикер", "спикер", "ведущий"),
        requirement("program", "программа", "в программе", "программа встречи"),
        requirement("organizer", "организатор"),
        requirement("benefit", "неподтверждённая выгода", "сертификат", "готовые шаблоны"),
      ],
      constraints: { maxEmoji: 2, maxQuestions: 0, cta: "required", ctaPhrases: ["зарегистрируйтесь", url] },
    });
    const good = `15 сентября 2026 года в 19:00 пройдёт онлайн-встреча «Право и технологии: практика без хайпа» для юристов и руководителей. Участие бесплатно. Регистрация до 14 сентября: ${url} Зарегистрируйтесь.`;
    expect(validateFactualOutput(good, ledger, { now: checkedAt }).passed).toBe(true);

    const bad = `16 сентября 2026 года в 19:00 пройдёт встреча «Право и технологии: практика без хайпа» для юристов и руководителей. Бесплатно. Спикер Иван Петров разберёт программу. Регистрация до 14 сентября: https://example.com/other Зарегистрируйтесь.`;
    const codes = validateFactualOutput(bad, ledger, { now: checkedAt }).violations.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining([
      "missing_required_fact",
      "missing_required_url",
      "unsupported_number",
      "unsupported_date",
      "unsupported_url",
      "forbidden_claim",
    ]));
  });

  it("5. AI-помощник: сохраняет решение за юристом и блокирует обещания", () => {
    const facts = "Система анализирует черновик договора и отмечает пункты, которые отличаются от утверждённой политики. Финальное решение принимает юрист. Источники: договор и политика.";
    const ledger = baseLedger({
      domain: "technology",
      evidence: [{ id: "brief", text: facts, source: "brief" }],
      required: [
        requirement("analysis", "система анализирует черновик договора"),
        requirement("differences", "отмечает пункты, которые отличаются от утверждённой политики"),
        requirement("lawyer", "финальное решение принимает юрист"),
        requirement("contract-source", "источник — договор", "источники: договор", "источники — договор"),
        requirement("policy-source", "источник — политика", "и политика", "источники: договор и политика"),
      ],
      forbiddenClaims: [
        requirement("accuracy", "обещание точности", "100% точность", "безошибочно"),
        requirement("speed", "обещание скорости", "за минуту", "за секунды"),
        requirement("risk", "обещание снижения риска", "снижает риск", "исключает риск"),
      ],
      constraints: { maxEmoji: 0, maxQuestions: 0, cta: "forbidden", forbidPromises: true },
    });
    const good = "Система анализирует черновик договора и отмечает пункты, которые отличаются от утверждённой политики. Финальное решение принимает юрист. Источники: договор и политика.";
    expect(validateFactualOutput(good, ledger, { now: checkedAt }).passed).toBe(true);

    const bad = `${good} Это гарантирует 100% точность, экономит время и снижает риск. Попробуйте сейчас 🚀`;
    const codes = validateFactualOutput(bad, ledger, { now: checkedAt }).violations.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining([
      "forbidden_claim",
      "promise",
      "unsupported_number",
      "emoji_limit",
      "unexpected_cta",
    ]));
  });
});

describe("fact ledger integration contract", () => {
  it("строит fail-fast для строгого юридического longread до provider/reservation", () => {
    const task = "Напиши 1600–1900 знаков. Процедура реализации имущества — 6 месяцев. Срок может быть продлён определением арбитражного суда. Единственное пригодное жильё обычно исключено по ст. 446 ГПК РФ. Ипотечное жильё — исключение.";
    const ledger = buildFactLedger({
      task,
      postSettings: { ...DEFAULT_POST_SETTINGS, factStrictness: "verified" },
    });
    expect(ledger.domain).toBe("legal");
    expect(preflightFactLedger(ledger).passed).toBe(false);
  });

  it("hash стабилен, а безопасный смысловой вариант задаётся evidence variants", () => {
    const ledger = baseLedger({
      evidence: [{ id: "term", text: "Срок составляет 6 месяцев", source: "brief" }],
      required: [requirement("term", "срок 6 месяцев", "срок составляет 6 месяцев", "срок длится шесть месяцев")],
    });
    expect(factLedgerHash(ledger)).toBe(factLedgerHash(structuredClone(ledger)));
    expect(validateFactualOutput("Срок длится шесть месяцев.", ledger, { now: checkedAt }).passed).toBe(true);
  });
});
