export type CalendarTrendCandidate = Readonly<{
  id: number;
  text: string | null;
  competitorTitle: string | null;
  handle: string;
  ratio: number | null;
  idea: Readonly<{
    topic: string | null;
    hook: string | null;
  }> | null;
}>;

export type CalendarDailySuggestion = Readonly<{
  id: string;
  kind: "script" | "trend" | "format";
  label: string;
  title: string;
  prompt: string;
  actionLabel: string;
  multiplier?: number;
}>;

const ROTATING_FORMATS = [
  {
    label: "Разбор дня",
    title: "Объясните сложный вопрос на одном понятном примере",
    prompt: "Подготовь экспертный пост: объясни один сложный вопрос аудитории на понятном жизненном примере, добавь практический вывод и аккуратный призыв к обсуждению.",
  },
  {
    label: "Чек-лист дня",
    title: "Соберите короткий чек-лист, который хочется сохранить",
    prompt: "Подготовь полезный пост-чек-лист по главному вопросу аудитории: 5 конкретных пунктов, частая ошибка и один следующий шаг без неподтверждённых обещаний.",
  },
  {
    label: "Миф дня",
    title: "Разберите распространённое заблуждение аудитории",
    prompt: "Подготовь пост в формате «миф — почему он возникает — как правильно»: без категоричных неподтверждённых утверждений, с практичным выводом.",
  },
  {
    label: "Вопрос дня",
    title: "Начните разговор с вопроса, на который хочется ответить",
    prompt: "Подготовь вовлекающий пост с одним сильным вопросом аудитории, коротким экспертным контекстом и тремя вариантами ответа для обсуждения.",
  },
] as const;

function firstMeaningfulLine(value: string | null | undefined): string {
  return String(value ?? "")
    .split(/\n/u)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 120) ?? "";
}

function dayIndex(localDate: string): number {
  return [...localDate].reduce((total, character) => total + character.charCodeAt(0), 0);
}

export function buildCalendarDailySuggestions(input: {
  localDate: string;
  niche?: string | null;
  channelLabel?: string | null;
  trends?: readonly CalendarTrendCandidate[];
}): CalendarDailySuggestion[] {
  const subject = input.niche?.trim()
    || input.channelLabel?.trim()
    || "вашей темы";
  const trend = input.trends?.find((candidate) => (
    Boolean(candidate.idea?.topic?.trim() || candidate.text?.trim())
  ));
  const trendTopic = firstMeaningfulLine(trend?.idea?.topic || trend?.text);
  const trendSource = trend?.competitorTitle?.trim()
    || (trend?.handle ? `@${trend.handle.replace(/^@/u, "")}` : "публичных источников");
  const rotating = ROTATING_FORMATS[dayIndex(input.localDate) % ROTATING_FORMATS.length];

  return [
    {
      id: `${input.localDate}:script`,
      kind: "script",
      label: "Сценарий дня",
      title: `Короткое видео: один полезный ответ по теме «${subject}»`,
      prompt: `Напиши сценарий короткого вертикального видео по теме «${subject}»: сильный хук, 3 короткие сцены, практический вывод и CTA. Не выдумывай факты.`,
      actionLabel: "Открыть сценарий",
    },
    trend
      ? {
          id: `${input.localDate}:trend:${trend.id}`,
          kind: "trend",
          label: "Тренд дня",
          title: trendTopic || `Свежая механика из ${trendSource}`,
          prompt: `Создай самостоятельный пост по теме «${trendTopic || subject}», используя только механику и структуру примера из ${trendSource}. Не копируй формулировки и не переноси неподтверждённые факты.`,
          actionLabel: "Адаптировать тренд",
          ...(trend.ratio != null && trend.ratio > 0 ? { multiplier: trend.ratio } : {}),
        }
      : {
          id: `${input.localDate}:trend-check`,
          kind: "trend",
          label: "Тренд дня",
          title: `Проверьте, что изменилось в теме «${subject}» за неделю`,
          prompt: `Подготовь пост-наблюдение по теме «${subject}». Сначала обозначь, какой свежий сигнал нужно проверить в публичных источниках, затем предложи безопасную структуру поста без выдуманных фактов.`,
          actionLabel: "Подготовить разбор",
        },
    {
      id: `${input.localDate}:format:${dayIndex(input.localDate) % ROTATING_FORMATS.length}`,
      kind: "format",
      label: rotating.label,
      title: rotating.title,
      prompt: `${rotating.prompt} Тема канала: «${subject}».`,
      actionLabel: "Открыть идею",
    },
  ];
}

export function calendarSuggestionComposerHref(suggestion: CalendarDailySuggestion): string {
  const params = new URLSearchParams({
    from: "calendar",
    idea: suggestion.prompt,
    assistant: suggestion.kind === "script" ? "script" : "write",
  });
  return `/app/composer?${params.toString()}`;
}
