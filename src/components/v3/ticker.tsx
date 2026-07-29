// Тикер-лента формулы продукта. Чёрная полоса, жёлтый моно-текст.
// Два одинаковых блока в треке — translateX(-50%) даёт бесшовную петлю.
// Reduced-motion: лента статична (см. v3.css).
const ITEMS = [
  "Разведка",
  "ИИ-контент",
  "Автопостинг",
  "Реакции",
  "И снова разведка, уже умнее",
] as const;

function Row({ hidden }: { hidden?: boolean }) {
  return (
    <div className="flex shrink-0" aria-hidden={hidden || undefined}>
      {ITEMS.map((item) => (
        <span key={item} className="v3-ticker-item">
          {item}
          <span aria-hidden>✦</span>
        </span>
      ))}
    </div>
  );
}

export function V3Ticker() {
  return (
    <div className="v3-ticker" role="marquee" aria-label="Формула продукта">
      <div className="v3-ticker-track">
        <Row />
        <Row hidden />
      </div>
    </div>
  );
}
