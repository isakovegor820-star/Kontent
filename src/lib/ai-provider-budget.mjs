/** Navy's token cap includes hidden reasoning as well as the visible answer. */
export function providerOutputTokens(engine, requested, expanded = false) {
  return engine.startsWith("navy-")
    ? Math.max(expanded ? 6_000 : 3_000, requested)
    : requested;
}
