import { cn } from "@/lib/utils";

/** Общий воздушный фон первого экрана и ключевых секций лендинга. */
export function AirWave({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "air-wave-field pointer-events-none absolute inset-0",
        className,
      )}
    >
      <span className="air-ambient-orb air-ambient-orb-1" />
      <span className="air-ambient-orb air-ambient-orb-2" />
      <span className="air-ambient-orb air-ambient-orb-3" />
      <span className="air-wave-layer air-wave-layer-1" />
      <span className="air-wave-layer air-wave-layer-2" />
      <span className="air-wave-layer air-wave-layer-3" />
      <span className="air-wave-layer air-wave-layer-4" />
      <span className="air-wave-ribbon air-wave-ribbon-1" />
      <span className="air-wave-ribbon air-wave-ribbon-2" />
      <span className="air-wave-sheen" />
      <span className="air-wave-glint air-wave-glint-1" />
      <span className="air-wave-glint air-wave-glint-2" />
    </div>
  );
}
