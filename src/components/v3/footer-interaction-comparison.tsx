import { V3KineticFooterLab, type FooterInteractionVariant } from "./kinetic-footer-lab";
import styles from "./footer-interaction-comparison.module.css";

const OPTIONS: Array<{
  id: FooterInteractionVariant;
  title: string;
  instruction: string;
}> = [
  {
    id: 1,
    title: "Разбуди Аврору",
    instruction: "Нажми на все шесть букв — после последней сработает общий финал.",
  },
  {
    id: 2,
    title: "Типографическая физика",
    instruction: "Хватай и бросай буквы. Обычный клик подбрасывает выбранную букву.",
  },
  {
    id: 3,
    title: "Визуальный секвенсор",
    instruction: "Каждая буква включает свой слой. Запусти все шесть одновременно.",
  },
];

export function FooterInteractionComparison() {
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <p>Сравнение / ничего не выбрано</p>
        <h1>Три механики одного футера</h1>
        <div>
          <span>Все варианты живые и кликабельные.</span>
          <strong>Основной лендинг не изменён.</strong>
        </div>
      </header>

      <nav className={styles.jumpNav} aria-label="Перейти к механике">
        {OPTIONS.map((option) => (
          <a key={option.id} href={`#mechanic-${option.id}`}>
            <span>0{option.id}</span>
            {option.title}
          </a>
        ))}
      </nav>

      {OPTIONS.map((option) => (
        <section key={option.id} id={`mechanic-${option.id}`} className={styles.option}>
          <header className={styles.optionHead}>
            <span>Вариант 0{option.id}</span>
            <h2>{option.title}</h2>
            <p>{option.instruction}</p>
          </header>
          <V3KineticFooterLab
            variant={option.id}
            showSwitcher={false}
            footerId={`mechanic-${option.id}-footer`}
          />
        </section>
      ))}

      <footer className={styles.endNote}>
        <strong>Сначала попробуй все три.</strong>
        <span>После выбора перенесём только победителя на основной лендинг.</span>
      </footer>
    </main>
  );
}
