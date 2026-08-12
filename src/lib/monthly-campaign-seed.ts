import type {
  MonthlyCampaignFunnelStage,
  MonthlyCampaignSummary,
  NormalizedMonthlyCampaignItem,
} from "./monthly-campaign-service";

type SeedCampaign = {
  startsOn: MonthlyCampaignSummary["startsOn"];
  endsOn: MonthlyCampaignSummary["endsOn"];
  rubrics: readonly string[];
  practiceMix: ReadonlyArray<MonthlyCampaignSummary["practiceMix"][number]>;
  funnelStages: ReadonlyArray<MonthlyCampaignSummary["funnelStages"][number]>;
  importantDates: ReadonlyArray<MonthlyCampaignSummary["importantDates"][number]>;
  audience: MonthlyCampaignSummary["audience"];
};

const DAY_MS = 86_400_000;

const ANGLES = [
  (practice: string) => `Что проверить в работе по направлению «${practice}»`,
  (practice: string) => `Три шага перед обращением по вопросу «${practice}»`,
  (practice: string) => `Частая ошибка бизнеса в вопросах «${practice}»`,
  (practice: string) => `Какие документы подготовить по направлению «${practice}»`,
  (practice: string) => `Миф и факт о направлении «${practice}»`,
  (practice: string) => `Когда по вопросу «${practice}» нужен специалист`,
  (practice: string) => `Вопрос клиента о направлении «${practice}»`,
  (practice: string) => `Чек-лист для первичной оценки: «${practice}»`,
  (practice: string) => `Как снизить риск спора по направлению «${practice}»`,
  (practice: string) => `Что обсудить с командой по вопросу «${practice}»`,
  (practice: string) => `Как подготовиться к переговорам: «${practice}»`,
  (practice: string) => `Красные флаги в документах: «${practice}»`,
  (practice: string) => `Пять вопросов для внутренней проверки: «${practice}»`,
  (practice: string) => `Что зафиксировать письменно по вопросу «${practice}»`,
  (practice: string) => `Где бизнес теряет время в направлении «${practice}»`,
  (practice: string) => `Как распределить ответственность: «${practice}»`,
  (practice: string) => `До и после юридической проверки: «${practice}»`,
  (practice: string) => `Короткий разбор риска по направлению «${practice}»`,
  (practice: string) => `Что спросить у контрагента: «${practice}»`,
  (practice: string) => `Как проверить полномочия и документы: «${practice}»`,
  (practice: string) => `Практический алгоритм по направлению «${practice}»`,
  (practice: string) => `Почему шаблонного решения мало: «${practice}»`,
  (practice: string) => `Что сохранить для доказательств: «${practice}»`,
  (practice: string) => `Как оценить срочность вопроса «${practice}»`,
  (practice: string) => `Роли руководителя и юриста: «${practice}»`,
  (practice: string) => `Что проверить перед подписанием: «${practice}»`,
  (practice: string) => `Как не пропустить важное в вопросе «${practice}»`,
  (practice: string) => `Памятка собственнику: «${practice}»`,
  (practice: string) => `Разбор типовой ситуации: «${practice}»`,
  (practice: string) => `Когда откладывать вопрос «${practice}» рискованно`,
  (practice: string) => `Итоги месяца и следующие шаги: «${practice}»`,
] as const;

function datesBetween(startsOn: string, endsOn: string): string[] {
  const start = Date.parse(`${startsOn}T00:00:00.000Z`);
  const end = Date.parse(`${endsOn}T00:00:00.000Z`);
  const dates: string[] = [];
  for (let at = start; at <= end; at += DAY_MS) dates.push(new Date(at).toISOString().slice(0, 10));
  return dates;
}

function weightedPractices(campaign: SeedCampaign, count: number): string[] {
  const result: string[] = [];
  const remaining = campaign.practiceMix.map((practice) => ({
    name: practice.name,
    exact: (practice.weight / 100) * count,
    allocated: 0,
  }));
  for (let index = 0; index < count; index += 1) {
    remaining.sort((left, right) =>
      (right.exact - right.allocated) - (left.exact - left.allocated)
      || left.name.localeCompare(right.name, "ru-RU"),
    );
    const selected = remaining[0];
    selected.allocated += 1;
    result.push(selected.name);
  }
  return result;
}

function importantDateTitle(campaign: SeedCampaign, date: string): string | null {
  const important = campaign.importantDates.find((item) => item.date === date);
  return important ? `Что проверить перед событием «${important.label}»` : null;
}

/**
 * Creates a fact-free editorial skeleton on the server. It deliberately does not invent
 * laws, dates, cases or promises. AI regeneration may later improve a selected item/week,
 * while the approved remainder keeps its identity and lineage.
 */
export function buildMonthlyCampaignSeedItems(campaign: SeedCampaign): NormalizedMonthlyCampaignItem[] {
  const dates = datesBetween(campaign.startsOn, campaign.endsOn);
  if (dates.length < 28 || dates.length > 31) throw new RangeError("campaign period must contain 28–31 days");
  if (!campaign.rubrics.length || !campaign.practiceMix.length || !campaign.funnelStages.length) {
    throw new RangeError("campaign taxonomy is incomplete");
  }
  const practices = weightedPractices(campaign, dates.length);
  return dates.map((scheduledFor, position) => {
    const practice = practices[position];
    const rubric = campaign.rubrics[position % campaign.rubrics.length];
    const funnelStage = campaign.funnelStages[
      position % campaign.funnelStages.length
    ] as MonthlyCampaignFunnelStage;
    const title = importantDateTitle(campaign, scheduledFor)
      ?? ANGLES[position % ANGLES.length](practice);
    return {
      itemKey: `day-${scheduledFor}`,
      scheduledFor,
      position,
      title,
      rubric,
      practice,
      funnelStage,
      state: position < 7 ? "detailed" : "topic",
    };
  });
}
