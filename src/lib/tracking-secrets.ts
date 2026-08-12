export type TrackingSecrets = {
  attributionSecret: string;
  fingerprintSecret: string;
};

function requiredSecret(name: "TRACKING_ATTRIBUTION_SECRET" | "TRACKING_FINGERPRINT_SECRET") {
  const value = process.env[name]?.trim() ?? "";
  if (value.length < 32) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
}

export function getTrackingSecrets(): TrackingSecrets {
  const attributionSecret = requiredSecret("TRACKING_ATTRIBUTION_SECRET");
  const fingerprintSecret = requiredSecret("TRACKING_FINGERPRINT_SECRET");
  if (attributionSecret === fingerprintSecret) throw new Error("tracking_secrets_must_differ");
  return { attributionSecret, fingerprintSecret };
}
