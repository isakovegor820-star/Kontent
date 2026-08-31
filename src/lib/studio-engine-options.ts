export type StudioEngineAvailability = {
  supported: boolean;
  status: "ready" | "no_key" | "offline";
};

/** The Studio picker is an action menu, so it only exposes models usable right now. */
export function readyStudioEngines<T extends StudioEngineAvailability>(engines: readonly T[]): T[] {
  return engines.filter((engine) => engine.supported && engine.status === "ready");
}
