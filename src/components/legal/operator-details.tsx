import { LEGAL_EMAIL, LEGAL_ENTITY, hasOperatorDetails, type LegalEntity } from "@/lib/contact";

/**
 * Сведения об операторе персональных данных.
 *
 * Зачем отдельный блок, а не строка в тексте документа: реквизиты — это один
 * и тот же факт на всех правовых страницах, и он должен меняться в одном месте
 * (`src/lib/contact.ts`). Пока владелец не подтвердил реквизиты, блок честно
 * сообщает, что сведения уточняются, вместо пустой строки «ИНН: » —
 * незаполненный реквизит на юридической странице читается как утверждение.
 *
 * Заполнение — трек B плана исправлений: меняются значения в `LEGAL_ENTITY`,
 * этот компонент и страницы не переписываются.
 */
export function OperatorDetails({
  entity = LEGAL_ENTITY as LegalEntity,
  variant = "section",
}: {
  entity?: LegalEntity;
  variant?: "section" | "inline";
}) {
  const confirmed = hasOperatorDetails(entity);

  if (!confirmed) {
    const note =
      "Оператор сервиса — владелец платформы. Полное наименование, ИНН, ОГРН и адрес " +
      `уточняются и будут опубликованы здесь. Запросы о данных принимаются по адресу ${LEGAL_EMAIL}.`;

    return variant === "inline" ? (
      <p>{note}</p>
    ) : (
      <section aria-labelledby="operator-details">
        <h2 id="operator-details">Оператор и его реквизиты</h2>
        <p>{note}</p>
      </section>
    );
  }

  const rows: Array<[string, string]> = [
    ["Наименование", entity.name as string],
    ["ИНН", entity.inn as string],
    ["ОГРН", entity.ogrn as string],
    ["Адрес", entity.address as string],
  ];

  return variant === "inline" ? (
    <p>
      {rows.map(([label, value]) => `${label}: ${value}`).join(" · ")} · {LEGAL_EMAIL}
    </p>
  ) : (
    <section aria-labelledby="operator-details">
      <h2 id="operator-details">Оператор и его реквизиты</h2>
      <ul>
        {rows.map(([label, value]) => (
          <li key={label}>
            {label}: {value}
          </li>
        ))}
        <li>Запросы о данных: {LEGAL_EMAIL}</li>
      </ul>
    </section>
  );
}
