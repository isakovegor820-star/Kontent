import "@fontsource-variable/onest/wght.css";
import { Access } from "./access";
import { Author } from "./author";
import styles from "./bento.module.css";
import { Cta } from "./cta";
import { Evidence } from "./evidence";
import { Faq } from "./faq";
import { Features } from "./features";
import { Fit } from "./fit";
import { Footer } from "./footer";
import { Hero } from "./hero";
import { Integrations } from "./integrations";
import { Nav } from "./nav";
import { Pricing } from "./pricing";
import { Product } from "./product";
import { Standard } from "./standard";
import { Steps } from "./steps";

/**
 * Главная страница Авроры.
 *
 * Дизайн — из утверждённого макета владельца (`docs/design-refs/aurora-bento.html`),
 * стили — из одного модуля `bento.module.css`. Порядок блоков — из логики чтения:
 * что это → кому → что умеет → как устроено → вопросы → действие.
 *
 * Тексты о продукте приходят из `lib/product`, `lib/seo/faq`, `lib/author`:
 * страница не заводит второй источник правды о себе.
 *
 * Два блока удалены с главной по решению владельца 4 октября 2026: сравнение с
 * сервисами отложенного постинга и отдельный блок прямого ответа («Коротко»).
 * Данные обоих сохранены (`lib/comparison.ts`, `PRODUCT_ANSWER` в `lib/product.ts`),
 * но нигде не рендерятся: это проверенные формулировки, а не вёрстка.
 */
export function AuroraLanding() {
  return (
    <div className={styles.site}>
      <Nav />
      <main id="main">
        <Hero />
        <Fit />
        <Features />
        <Evidence />
        <Steps />
        <Product />
        <Integrations />
        <Standard />
        <Access />
        <Pricing />
        <Faq />
        <Author />
        <Cta />
      </main>
      <Footer />
    </div>
  );
}
