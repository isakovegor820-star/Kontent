// Last-mile sanitization: SDK enrichment can add URLs after beforeSend/breadcrumb hooks.
// Use the final envelope hook for errors, transactions, spans, logs and request metadata.
const SECRET_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|token)$/i;

export function scrubTelemetryText(value) {
  return value
    .replace(/(\/(?:file\/)?bot)[A-Za-z0-9_:%-]+(?=\/|[?\s"'<>]|$)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@"']+:[^\s/@"']+@/gi, '$1[REDACTED]@')
    .replace(/((?:^|[?&])(?:access_token|refresh_token|api_key|apikey|key|token|secret|password|client_secret)=)[^&#\s"']*/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:~-]+/gi, '$1 [REDACTED]');
}

export function scrubTelemetry(value, seen = new WeakSet()) {
  if (typeof value === 'string') return scrubTelemetryText(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  // Envelope payloads are plain objects. Do not reinterpret attachments or binary framing.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  for (const key of Object.keys(value)) {
    const cleanKey = scrubTelemetryText(key);
    const clean = SECRET_FIELD.test(key) ? '[REDACTED]' : scrubTelemetry(value[key], seen);
    if (cleanKey !== key) delete value[key];
    value[cleanKey] = clean;
  }
  return value;
}

export function telemetryScrubIntegration() {
  return {
    name: 'AuroraTelemetryScrub',
    setup(client) {
      client.on('beforeEnvelope', (envelope) => { scrubTelemetry(envelope); });
    },
  };
}
