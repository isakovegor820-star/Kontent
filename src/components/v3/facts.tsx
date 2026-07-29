// Факты-полоса: четыре честные цифры в ячейках с чёрными линейками.
// «104 агента разведки» убрано — внутренний жаргон ничего не говорит посетителю.
import { V3Reveal } from "./reveal";

const FACTS = [
  { value: "8", caption: "сервисов протестировали руками" },
  { value: "2–3 ч", caption: "цикл разведки конкурентов" },
  { value: "15 мин", caption: "в неделю занимает контроль" },
  { value: "0 ₽", caption: "на старте, лимиты честные" },
] as const;

export function V3Facts() {
  return (
    <section aria-label="Факты о платформе" className="border-b-2 border-[var(--ink)]">
      <div className="v3-wrap">
        <V3Reveal>
          <dl className="grid grid-cols-2 border-x-2 border-[var(--ink)] bg-[var(--sheet)] lg:grid-cols-4">
            {FACTS.map((f, i) => (
              <div
                key={f.caption}
                className={`flex flex-col border-[var(--ink)] px-5 py-7 sm:px-7 ${
                  i % 2 === 1 ? "border-l-2" : ""
                } ${i > 1 ? "border-t-2 lg:border-t-0" : ""} ${i > 0 ? "lg:border-l-2" : ""}`}
              >
                <dt className="order-2 v3-mono mt-2 block text-[11px] leading-snug tracking-[0.08em] text-[var(--ink-2)] uppercase">
                  {f.caption}
                </dt>
                <dd className="v3-display order-1 text-[clamp(1.9rem,4vw,2.9rem)] leading-none font-black">
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        </V3Reveal>
      </div>
    </section>
  );
}
