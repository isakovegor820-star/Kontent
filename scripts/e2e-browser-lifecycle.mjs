function combinedError(errors) {
  if (errors.length === 0) return undefined;
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, "E2E browser lifecycle failed: " + errors.map((error) => String(error?.message ?? error)).join("; "), { cause: errors[0] });
}

/** Drain owned resources before asserting or publishing the final boundary evidence. */
export async function finalizeE2eBrowserLifecycle({ context, transport, boundary, error,
  beforeClose = [], cleanup = [], assertDiagnostics, writeEvidence } = {}) {
  const errors = error === undefined ? [] : [error];
  const attempt = async (action) => {
    try { return await action(); } catch (failure) { errors.push(failure); }
  };
  for (const action of beforeClose) await attempt(action);
  if (context) await attempt(() => context.close());
  if (transport) await attempt(() => transport.stop());
  for (const action of cleanup) await attempt(action);
  if (boundary) await attempt(() => boundary.assertClean());
  if (transport) await attempt(() => transport.assertClean());
  // Renderer events can arrive during context/browser close. Check their final
  // collected state before writing or returning a successful evidence object.
  if (assertDiagnostics) await attempt(assertDiagnostics);
  const externalAttempts = boundary ? await attempt(() => boundary.snapshot()) : [];
  const transportAttempts = transport ? await attempt(() => transport.snapshot()) : [];
  if (writeEvidence) await attempt(() => writeEvidence({ error: combinedError(errors), externalAttempts, transportAttempts }));
  const failure = combinedError(errors);
  if (failure !== undefined) throw failure;
  return { externalAttempts, transportAttempts };
}
