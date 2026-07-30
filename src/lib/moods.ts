// Настроение агента (персона для Hermes). Связка из 1–3 профилей на аккаунт применяется ко всей генерации
// (студия, автопилот, идеи «Сними это»). Механика: инструкция в системный промпт + температура
// (радостный/дерзкий — живее, экспертный/спокойный — сдержаннее). Единый источник правды:
// отсюда берут и переходник ai-provider, и роут настроек, и интерфейс.

export interface Mood {
  label: string;
  emoji: string;
  description: string;
  prompt: string; // инструкция, которая уходит в системный промпт
  temp: number; // температура генерации
}

export const MOODS: Record<string, Mood> = {
  friendly: {
    label: "Тёплый",
    emoji: "🙂",
    description: "По-человечески и близко, без фамильярности.",
    prompt: [
      "Редакторский профиль — тёплый.",
      "Пиши как внимательный собеседник: понятно, бережно и без дистанции.",
      "Используй живые слова и мягкие переходы, но не скатывайся в сюсюканье, фамильярность или искусственную заботу.",
      "Доверие создавай точностью и эмпатией, а не комплиментами читателю.",
    ].join(" "),
    temp: 0.58,
  },
  cheerful: {
    label: "Энергичный",
    emoji: "😄",
    description: "Живой темп без крика и восторженной карикатуры.",
    prompt: [
      "Редакторский профиль — энергичный.",
      "Создай ощущение движения короткими сильными фразами, активными глаголами и быстрым ритмом.",
      "Не изображай истерический восторг: не нанизывай восклицания, не пиши капслоком, не называй серьёзную проблему прекрасной или радостной.",
      "Эмодзи используй только если их просит пользователь; энергия должна жить в смысле и ритме текста.",
    ].join(" "),
    temp: 0.66,
  },
  expert: {
    label: "Экспертный",
    emoji: "🎓",
    description: "Точно, доказательно и понятно без канцелярита.",
    prompt: [
      "Редакторский профиль — экспертный.",
      "Сначала дай ясный тезис, затем объясни логику и практическое значение для читателя.",
      "Термины сразу расшифровывай простыми словами; отделяй факт от мнения и не маскируй отсутствие данных уверенным тоном.",
      "Не используй канцелярит, академическую тяжесть и пустые заявления об экспертности.",
    ].join(" "),
    temp: 0.42,
  },
  bold: {
    label: "Дерзкий",
    emoji: "🔥",
    description: "Сильная позиция без хамства и дешёвого хайпа.",
    prompt: [
      "Редакторский профиль — дерзкий.",
      "Займи ясную позицию, называй проблему прямо и смело спорь с распространённым заблуждением.",
      "Остроту создавай точным наблюдением и контрастом, а не хамством, унижением, матом или кликбейтом.",
      "Каждую сильную формулировку подкрепляй логикой; не провоцируй ради самой провокации.",
    ].join(" "),
    temp: 0.7,
  },
  inspiring: {
    label: "Вдохновляющий",
    emoji: "✨",
    description: "Даёт надежду через реалистичный следующий шаг.",
    prompt: [
      "Редакторский профиль — вдохновляющий.",
      "Покажи достижимую возможность и закончи конкретным первым шагом, который читатель может сделать.",
      "Не обещай лёгкого успеха, не обесценивай сложность и не используй мотивационные штампы.",
      "Надежда должна опираться на понятную логику, а не на лозунги.",
    ].join(" "),
    temp: 0.62,
  },
  ironic: {
    label: "Ироничный",
    emoji: "😏",
    description: "Умная улыбка, которая усиливает мысль.",
    prompt: [
      "Редакторский профиль — ироничный.",
      "Добавь одно-два точных ироничных наблюдения там, где они усиливают основную мысль.",
      "Шути над ситуацией или привычкой, но не над читателем, уязвимой группой или чужой болью.",
      "Не превращай весь пост в стендап и не объясняй шутку.",
    ].join(" "),
    temp: 0.68,
  },
  calm: {
    label: "Спокойный",
    emoji: "🌿",
    description: "Собранно и надёжно для сложных или чувствительных тем.",
    prompt: [
      "Редакторский профиль — спокойный.",
      "Веди читателя последовательно: тезис, объяснение, следующий шаг.",
      "Пиши ровно и уверенно, без давления на страх, надрыва, восклицаний и ложной срочности.",
      "Сохраняй человечность: спокойствие не должно звучать холодно или бюрократично.",
    ].join(" "),
    temp: 0.4,
  },
};

export const DEFAULT_MOOD = "expert";
export const MAX_MOOD_SELECTION = 3;

/** Проверка, что ключ настроения валидный. */
export function isMood(key: unknown): key is string {
  return typeof key === "string" && key in MOODS;
}

function moodCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return [];
    }
  }
  return [trimmed];
}

/** Читает и новый JSON-массив из БД, и старый одиночный ключ. Всегда возвращает 1–3 профиля. */
export function normalizeMoodSelection(value: unknown): string[] {
  const unique = moodCandidates(value).filter(isMood).filter((key, index, all) => all.indexOf(key) === index);
  return unique.slice(0, MAX_MOOD_SELECTION).length
    ? unique.slice(0, MAX_MOOD_SELECTION)
    : [DEFAULT_MOOD];
}

/** Строгая проверка входа API: одиночный legacy-ключ или массив из 1–3 уникальных ключей. */
export function isMoodSelection(value: unknown): boolean {
  const candidates = moodCandidates(value);
  return (
    candidates.length >= 1 &&
    candidates.length <= MAX_MOOD_SELECTION &&
    candidates.every(isMood) &&
    new Set(candidates).size === candidates.length
  );
}

/** Инструкция связки настроений для системного промпта (по умолчанию — экспертный). */
export function moodPrompt(value: string | string[] | null | undefined): string {
  const keys = normalizeMoodSelection(value);
  const profiles = keys.map((key) => MOODS[key]);
  const combination =
    profiles.length > 1
      ? `Редакторская связка из ${profiles.length} профилей: ${profiles.map((profile) => profile.label).join(" + ")}. Сочетай их одновременно: каждый профиль должен быть слышен, но точность и уместность важнее эмоциональной силы.`
      : `Выбран один редакторский профиль: ${profiles[0].label}.`;
  return [
    combination,
    ...profiles.map((profile) => profile.prompt),
    "Настроение меняет лексику, ритм и эмоциональную дистанцию, но не отменяет фактическую точность, формат и прямые ограничения пользователя.",
  ].join(" ");
}

/** Для связки берём среднюю температуру: профили смешиваются, а не перетягивают генерацию. */
export function moodTemp(value: string | string[] | null | undefined): number {
  const profiles = normalizeMoodSelection(value).map((key) => MOODS[key]);
  const average = profiles.reduce((sum, profile) => sum + profile.temp, 0) / profiles.length;
  return Math.round(average * 100) / 100;
}
