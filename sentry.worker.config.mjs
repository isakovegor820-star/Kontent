import * as Sentry from "@sentry/node";

const isProduction = process.env.NODE_ENV === "production";
const sentryDisabled = process.env.AURORA_SENTRY_DISABLED === "1";
const configuredTraceRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "");
const tracesSampleRate = Number.isFinite(configuredTraceRate)
  && configuredTraceRate >= 0
  && configuredTraceRate <= 1
  ? configuredTraceRate
  : isProduction ? 0.1 : 1;

Sentry.init({
  dsn: "https://ed2eb6d188015427081dc1ed0c80b884@o4511981780402176.ingest.de.sentry.io/4511981792329808",
  enabled: !sentryDisabled && (isProduction || process.env.SENTRY_ENABLE_DEV === "true"),
  environment: process.env.SENTRY_ENVIRONMENT ?? (isProduction ? "prod" : "development"),
  tracesSampleRate,
  sendDefaultPii: false,
});
